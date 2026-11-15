// The GraphQL v4 surface (POST /api/graphql): a small self-contained GraphQL implementation — lexer,
// parser, executor and resolvers over the same store the REST and git surfaces use, so an object
// created on one surface reads identically on the others. Supports the query/mutation shapes gh and
// the github-mcp-server send: viewer, repository, node(id:), issues/pullRequests connections with
// cursor pagination, the issue/pull-request mutations, Relay global ids, operation batching (an
// array body answers an array of per-operation bodies), and the __type introspection probes gh
// feature-detects with. A GraphQL-level failure (an unknown field, a bad input) is a 200 whose body
// carries `errors`; authentication is the HTTP layer's job (401 before this module runs).

import { store, VIEWER, repoLookup, commitTreeOid, mergeTrees } from './store.ts';
import type { Repo, Issue, PullExtra, IssueComment } from './store.ts';
import { mergeBase } from './git.ts';
import {
  HttpError,
  createIssue as restCreateIssue,
  patchIssue as restPatchIssue,
  addComment as restAddComment,
  createPull as restCreatePull,
  mergePull as restMergePull,
  pullFiles as restPullFiles,
} from './rest.ts';
import type { Reply } from './app.ts';

// --------------------------------------------------------------------------- global (Relay) ids

/** A global id is the base64 of "<Type>:<numeric id>": opaque (never the bare number), stable. */
export function globalId(type: string, numericId: number): string {
  return Buffer.from(`${type}:${numericId}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, numericId: Number(match[2]) };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === parsed.numericId) return repo;
  return null;
}

function issueByGlobalId(id: string, wantPull: boolean): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type !== (wantPull ? 'PullRequest' : 'Issue')) return null;
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === parsed.numericId && issue.isPull === wantPull) return { repo, issue };
    }
  }
  return null;
}

function commentByGlobalId(id: string): { repo: Repo; issue: Issue; comment: IssueComment } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'IssueComment') return null;
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      for (const comment of issue.comments) {
        if (comment.id === parsed.numericId) return { repo, issue, comment };
      }
    }
  }
  return null;
}

// --------------------------------------------------------------------------- lexer

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'eof' };

class GqlError extends Error {}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        const ch = source[j] as string;
        if (ch === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else throw new GqlError(`invalid escape \\${esc}`);
          j += 2;
          continue;
        }
        value += ch;
        j += 1;
      }
      if (j >= source.length) throw new GqlError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[] };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyMap<string, ValueNode>;
  readonly selectionSet: readonly SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { readonly kind: 'spread'; readonly name: string }
  | { readonly kind: 'inline'; readonly typeCondition: string | null; readonly selectionSet: readonly SelectionNode[] };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selectionSet: readonly SelectionNode[];
  readonly variableDefaults: ReadonlyMap<string, ValueNode>;
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, { readonly typeCondition: string | null; readonly selectionSet: readonly SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new GqlError(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GqlError('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: readonly SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet(), variableDefaults: new Map() });
        continue;
      }
      if (token.kind !== 'name') throw new GqlError('expected an operation or fragment definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.parseVariableDefinitions(variableDefaults);
        }
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
          variableDefaults,
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new GqlError('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new GqlError(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) defaults.set(name, this.parseValue());
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): readonly SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '...') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: readonly SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlError('unexpected token in a value position');
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/** Resolve a value node against the operation's variables. Enums surface as their name string. */
function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>, defaults: ReadonlyMap<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in variables) return variables[node.name];
      const fallback = defaults.get(node.name);
      return fallback === undefined ? undefined : valueOf(fallback, variables, defaults);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(value, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables, defaults);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- object wrappers

/** A GraphQL object in flight: a type tag plus the payload its resolvers read. */
interface GObj {
  readonly __type: string;
  readonly [key: string]: unknown;
}

function isGObj(value: unknown): value is GObj {
  return typeof value === 'object' && value !== null && typeof (value as { __type?: unknown }).__type === 'string';
}

function userObj(login: string, numericId: number, name: string, email: string | null): GObj {
  return { __type: 'User', login, numericId, name, email };
}

function viewerObj(): GObj {
  return userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email);
}

function ownerObj(login: string): GObj {
  return login === VIEWER.login ? viewerObj() : userObj(login, 0, login, null);
}

function repoObj(repo: Repo): GObj {
  return { __type: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): GObj {
  return { __type: 'Issue', repo, issue };
}

function pullObj(repo: Repo, issue: Issue, pull: PullExtra): GObj {
  return { __type: 'PullRequest', repo, issue, pull };
}

function commentObj(repo: Repo, issue: Issue, comment: IssueComment): GObj {
  return { __type: 'IssueComment', repo, issue, comment };
}

function pageInfoObj(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): GObj {
  return { __type: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor };
}

// --------------------------------------------------------------------------- connections

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: string): number | null {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Page<T> {
  readonly slice: readonly T[];
  readonly pageInfo: GObj;
}

/** Slice an already-ordered list by (first, after): the cursor names the last item of the prior page. */
function paginate<T>(items: readonly T[], args: Readonly<Record<string, unknown>>, seqOf: (item: T) => number): Page<T> {
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : 100;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const seq = seqOfCursor(args.after);
    if (seq !== null) {
      const index = items.findIndex((item) => seqOf(item) === seq);
      if (index >= 0) start = index + 1;
    }
  }
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  const endCursor = slice.length > 0 ? cursorOf(seqOf(slice[slice.length - 1] as T)) : null;
  const startCursor = slice.length > 0 ? cursorOf(seqOf(slice[0] as T)) : null;
  return { slice, pageInfo: pageInfoObj(hasNextPage, endCursor, startCursor) };
}

function issuesConnection(repo: Repo, args: Readonly<Record<string, unknown>>): GObj {
  let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
  issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const page = paginate(issues, args, (issue) => issue.seq);
  return {
    __type: 'IssueConnection',
    nodes: page.slice.map((issue) => issueObj(repo, issue)),
    pageInfo: page.pageInfo,
    totalCount: issues.length,
  };
}

function pullRequestsConnection(repo: Repo, args: Readonly<Record<string, unknown>>): GObj {
  let pulls = [...repo.issues.values()].filter((issue) => issue.isPull);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((issue) => {
      const pull = repo.pulls.get(issue.number) as PullExtra;
      const state = pull.merged ? 'MERGED' : issue.state.toUpperCase();
      return wanted.has(state);
    });
  }
  pulls.sort((a, b) => b.seq - a.seq);
  const page = paginate(pulls, args, (issue) => issue.seq);
  return {
    __type: 'PullRequestConnection',
    nodes: page.slice.map((issue) => pullObj(repo, issue, repo.pulls.get(issue.number) as PullExtra)),
    pageInfo: page.pageInfo,
    totalCount: pulls.length,
  };
}

function pullFilesConnection(repo: Repo, pull: PullExtra): GObj {
  const files = restPullFiles(repo, pull);
  return {
    __type: 'PullRequestFileConnection',
    nodes: files.map((file) => ({
      __type: 'PullRequestFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
    })),
    totalCount: files.length,
  };
}

/** MERGEABLE / CONFLICTING by a dry-run three-way merge of the head into the base, else UNKNOWN. */
function mergeableOf(repo: Repo, pull: PullExtra): string {
  if (pull.merged) return 'MERGEABLE';
  const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headOid = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headOid;
  if (baseOid === undefined || headOid === undefined) return 'UNKNOWN';
  const base = mergeBase(baseOid, headOid, repoLookup(repo));
  if (base === null) return 'UNKNOWN';
  const baseTree = commitTreeOid(repo, base);
  const baseTipTree = commitTreeOid(repo, baseOid);
  const headTree = commitTreeOid(repo, headOid);
  if (baseTree === undefined || baseTipTree === undefined || headTree === undefined) return 'UNKNOWN';
  return mergeTrees(repo, baseTree, baseTipTree, headTree).ok ? 'MERGEABLE' : 'CONFLICTING';
}

function nodeByGlobalId(id: string): GObj | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByGlobalId(id);
    return repo === null ? null : repoObj(repo);
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const found = issueByGlobalId(id, parsed.type === 'PullRequest');
    if (found === null) return null;
    return found.issue.isPull
      ? pullObj(found.repo, found.issue, found.repo.pulls.get(found.issue.number) as PullExtra)
      : issueObj(found.repo, found.issue);
  }
  if (parsed.type === 'IssueComment') {
    const found = commentByGlobalId(id);
    return found === null ? null : commentObj(found.repo, found.issue, found.comment);
  }
  if (parsed.type === 'User') return parsed.numericId === VIEWER.id ? viewerObj() : null;
  return null;
}

// --------------------------------------------------------------------------- schema (introspection)

const OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'additions', 'deletions', 'changedFiles',
    'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'totalCount'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function typeObj(name: string): GObj | null {
  if (name in OBJECT_FIELDS) return { __type: '__Type', name, kind: 'OBJECT' };
  if (name in ENUM_VALUES) return { __type: '__Type', name, kind: 'ENUM' };
  return null;
}

// --------------------------------------------------------------------------- resolvers

type Resolver = (source: GObj, args: Readonly<Record<string, unknown>>) => unknown;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function inputOf(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return asRecord(args.input);
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => viewerObj(),
    repository: (_source, args) => {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_source, args) => (typeof args.id === 'string' ? nodeByGlobalId(args.id) : null),
    organization: () => null,
    user: (_source, args) => (args.login === VIEWER.login ? viewerObj() : null),
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = inputOf(args);
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (repo === null) throw new GqlError('Could not resolve to a Repository with the given global id');
      const issue = restCreateIssue(repo, {
        title: typeof input.title === 'string' ? input.title : undefined,
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      return { __type: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: null };
    },
    closeIssue: (_source, args) => {
      const input = inputOf(args);
      const found = typeof input.issueId === 'string' ? issueByGlobalId(input.issueId, false) : null;
      if (found === null) throw new GqlError('Could not resolve to an Issue with the given global id');
      restPatchIssue(found.repo, found.issue, { state: 'closed' });
      return { __type: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: null };
    },
    reopenIssue: (_source, args) => {
      const input = inputOf(args);
      const found = typeof input.issueId === 'string' ? issueByGlobalId(input.issueId, false) : null;
      if (found === null) throw new GqlError('Could not resolve to an Issue with the given global id');
      restPatchIssue(found.repo, found.issue, { state: 'open' });
      return { __type: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: null };
    },
    createPullRequest: (_source, args) => {
      const input = inputOf(args);
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (repo === null) throw new GqlError('Could not resolve to a Repository with the given global id');
      const created = restCreatePull(repo, {
        title: typeof input.title === 'string' ? input.title : undefined,
        body: typeof input.body === 'string' ? input.body : undefined,
        head: typeof input.headRefName === 'string' ? input.headRefName : undefined,
        base: typeof input.baseRefName === 'string' ? input.baseRefName : undefined,
      });
      const number = (created.body as { number: number }).number;
      const issue = repo.issues.get(number) as Issue;
      const pull = repo.pulls.get(number) as PullExtra;
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, issue, pull), clientMutationId: null };
    },
    mergePullRequest: (_source, args) => {
      const input = inputOf(args);
      const found = typeof input.pullRequestId === 'string' ? issueByGlobalId(input.pullRequestId, true) : null;
      if (found === null) throw new GqlError('Could not resolve to a PullRequest with the given global id');
      const pull = found.repo.pulls.get(found.issue.number) as PullExtra;
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      const method = methodRaw === 'squash' || methodRaw === 'rebase' ? methodRaw : 'merge';
      restMergePull(found.repo, found.issue, pull, method, typeof input.commitTitle === 'string' ? input.commitTitle : undefined);
      return { __type: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.issue, pull), clientMutationId: null };
    },
    addComment: (_source, args) => {
      const input = inputOf(args);
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const found = issueByGlobalId(subjectId, false) ?? issueByGlobalId(subjectId, true);
      if (found === null) throw new GqlError('Could not resolve to a commentable subject with the given global id');
      const comment = restAddComment(found.repo, found.issue, { body: typeof input.body === 'string' ? input.body : undefined });
      const subject = found.issue.isPull
        ? pullObj(found.repo, found.issue, found.repo.pulls.get(found.issue.number) as PullExtra)
        : issueObj(found.repo, found.issue);
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'CommentEdge', node: commentObj(found.repo, found.issue, comment), cursor: cursorOf(found.issue.seq) },
        subject,
        clientMutationId: null,
      };
    },
  },
  User: {
    id: (source) => globalId('User', source.numericId as number),
    login: (source) => source.login,
    name: (source) => source.name,
    email: (source) => source.email,
    avatarUrl: () => '',
    url: (source) => `https://github.com/${source.login as string}`,
  },
  Repository: {
    id: (source) => globalId('Repository', (source.repo as Repo).id),
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    owner: (source) => ownerObj((source.repo as Repo).owner),
    description: (source) => (source.repo as Repo).description,
    isPrivate: (source) => (source.repo as Repo).isPrivate,
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined || issue.isPull ? null : issueObj(repo, issue);
    },
    issues: (source, args) => issuesConnection(source.repo as Repo, args),
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      if (issue === undefined || !issue.isPull) return null;
      return pullObj(repo, issue, repo.pulls.get(issue.number) as PullExtra);
    },
    pullRequests: (source, args) => pullRequestsConnection(source.repo as Repo, args),
    createdAt: (source) => (source.repo as Repo).createdAt,
    updatedAt: (source) => (source.repo as Repo).updatedAt,
    url: (source) => `https://github.com/${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
  },
  Issue: {
    id: (source) => globalId('Issue', (source.issue as Issue).id),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    body: (source) => (source.issue as Issue).body ?? '',
    state: (source) => (source.issue as Issue).state.toUpperCase(),
    author: (source) => ownerObj((source.issue as Issue).user.login),
    labels: (source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      return issue.labels
        .map((name) => repo.labels.get(name))
        .filter((label) => label !== undefined)
        .map((label) => ({ __type: 'Label', labelId: label.id, name: label.name, color: label.color, description: label.description }));
    },
    comments: (source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      return {
        __type: 'IssueCommentConnection',
        nodes: issue.comments.map((comment) => commentObj(repo, issue, comment)),
        pageInfo: pageInfoObj(false, null, null),
        totalCount: issue.comments.length,
      };
    },
    createdAt: (source) => (source.issue as Issue).createdAt,
    updatedAt: (source) => (source.issue as Issue).updatedAt,
    closedAt: (source) => (source.issue as Issue).closedAt,
    url: (source) => `https://github.com/${(source.repo as Repo).owner}/${(source.repo as Repo).name}/issues/${(source.issue as Issue).number}`,
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.issue as Issue).id),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    body: (source) => (source.issue as Issue).body ?? '',
    state: (source) => {
      const pull = source.pull as PullExtra;
      const issue = source.issue as Issue;
      return pull.merged ? 'MERGED' : issue.state.toUpperCase();
    },
    merged: (source) => (source.pull as PullExtra).merged,
    mergeable: (source) => mergeableOf(source.repo as Repo, source.pull as PullExtra),
    headRefName: (source) => (source.pull as PullExtra).headRef,
    baseRefName: (source) => (source.pull as PullExtra).baseRef,
    headRef: (source) => ({ __type: 'Ref', name: (source.pull as PullExtra).headRef, prefix: 'refs/heads/' }),
    baseRef: (source) => ({ __type: 'Ref', name: (source.pull as PullExtra).baseRef, prefix: 'refs/heads/' }),
    files: (source) => pullFilesConnection(source.repo as Repo, source.pull as PullExtra),
    author: (source) => ownerObj((source.issue as Issue).user.login),
    additions: (source) => restPullFiles(source.repo as Repo, source.pull as PullExtra).reduce((sum, file) => sum + file.additions, 0),
    deletions: (source) => restPullFiles(source.repo as Repo, source.pull as PullExtra).reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: (source) => restPullFiles(source.repo as Repo, source.pull as PullExtra).length,
    createdAt: (source) => (source.issue as Issue).createdAt,
    updatedAt: (source) => (source.issue as Issue).updatedAt,
    closedAt: (source) => (source.issue as Issue).closedAt,
    mergedAt: (source) => (source.pull as PullExtra).mergedAt,
    url: (source) => `https://github.com/${(source.repo as Repo).owner}/${(source.repo as Repo).name}/pull/${(source.issue as Issue).number}`,
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', (source.comment as IssueComment).id),
    body: (source) => (source.comment as IssueComment).body,
    author: (source) => ownerObj((source.comment as IssueComment).user.login),
    createdAt: (source) => (source.comment as IssueComment).createdAt,
    updatedAt: (source) => (source.comment as IssueComment).updatedAt,
  },
  Label: {
    id: (source) => globalId('Label', source.labelId as number),
    name: (source) => source.name,
    color: (source) => source.color,
    description: (source) => source.description,
  },
  Ref: {
    name: (source) => source.name,
    prefix: (source) => source.prefix,
    target: () => null,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage,
    endCursor: (source) => source.endCursor,
    hasPreviousPage: (source) => source.hasPreviousPage,
    startCursor: (source) => source.startCursor,
  },
  IssueConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => source.totalCount,
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => source.totalCount,
  },
  PullRequestFileConnection: {
    nodes: (source) => source.nodes,
    totalCount: (source) => source.totalCount,
  },
  IssueCommentConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => source.totalCount,
  },
  PullRequestFile: {
    path: (source) => source.path,
    additions: (source) => source.additions,
    deletions: (source) => source.deletions,
    changeType: (source) => source.changeType,
  },
  CreateIssuePayload: {
    issue: (source) => source.issue,
    clientMutationId: (source) => source.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue,
    clientMutationId: (source) => source.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest,
    clientMutationId: (source) => source.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest,
    clientMutationId: (source) => source.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge,
    subject: (source) => source.subject,
    clientMutationId: (source) => source.clientMutationId,
  },
  CommentEdge: {
    node: (source) => source.node,
    cursor: (source) => source.cursor,
  },
  __Type: {
    name: (source) => source.name,
    kind: (source) => source.kind,
    description: () => null,
    fields: (source) => {
      const names = OBJECT_FIELDS[source.name as string];
      return names === undefined ? null : names.map((name) => ({ __type: '__Field', name }));
    },
    enumValues: (source) => {
      const values = ENUM_VALUES[source.name as string];
      return values === undefined ? null : values.map((name) => ({ __type: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (source) => source.name,
    description: () => null,
  },
  __EnumValue: {
    name: (source) => source.name,
    description: () => null,
  },
};

// --------------------------------------------------------------------------- executor

interface ExecContext {
  readonly doc: DocumentNode;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly defaults: ReadonlyMap<string, ValueNode>;
  readonly errors: { message: string; path?: readonly (string | number)[] }[];
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, node] of field.args) args[name] = valueOf(node, ctx.variables, ctx.defaults);
  return args;
}

function completeValue(value: unknown, selectionSet: readonly SelectionNode[] | null, ctx: ExecContext, path: readonly (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry, index) => completeValue(entry, selectionSet, ctx, [...path, index]));
  if (isGObj(value)) {
    if (selectionSet === null) return {};
    return executeSelectionSet(value.__type, value, selectionSet, ctx, path);
  }
  return value;
}

function executeSelectionSet(
  typeName: string,
  source: GObj,
  selections: readonly SelectionNode[],
  ctx: ExecContext,
  path: readonly (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (sels: readonly SelectionNode[]): void => {
    for (const sel of sels) {
      if (sel.kind === 'inline') {
        if (sel.typeCondition === null || sel.typeCondition === typeName) walk(sel.selectionSet);
        continue;
      }
      if (sel.kind === 'spread') {
        const fragment = ctx.doc.fragments.get(sel.name);
        if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName)) walk(fragment.selectionSet);
        continue;
      }
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      if (sel.name === '__type' && (typeName === 'Query' || typeName === 'Mutation')) {
        const args = argsOf(sel, ctx);
        const type = typeof args.name === 'string' ? typeObj(args.name) : null;
        out[key] = completeValue(type, sel.selectionSet, ctx, [...path, key]);
        continue;
      }
      const resolver = RESOLVERS[typeName]?.[sel.name];
      if (resolver === undefined) {
        ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${typeName}'`, path: [...path, key] });
        out[key] = null;
        continue;
      }
      let raw: unknown;
      try {
        raw = resolver(source, argsOf(sel, ctx));
      } catch (err) {
        const message = err instanceof HttpError || err instanceof Error ? err.message : String(err);
        ctx.errors.push({ message, path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(raw, sel.selectionSet, ctx, [...path, key]);
    }
  };
  walk(selections);
  return out;
}

function executeOperation(doc: DocumentNode, operation: OperationNode, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const ctx: ExecContext = { doc, variables, defaults: operation.variableDefaults, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __type: rootType }, operation.selectionSet, ctx, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function executeRequest(request: unknown): Record<string, unknown> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { errors: [{ message: 'A GraphQL request must be a JSON object with a query' }] };
  }
  const record = request as Record<string, unknown>;
  if (typeof record.query !== 'string') return { errors: [{ message: 'A GraphQL request needs a query string' }] };
  const variables = (typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)
    ? record.variables
    : {}) as Record<string, unknown>;
  let doc: DocumentNode;
  try {
    doc = parseDocument(record.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) return { errors: [{ message: 'The document holds no operation' }] };
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const operation = operationName === null ? doc.operations[0] : doc.operations.find((op) => op.name === operationName);
  if (operation === undefined) return { errors: [{ message: `Operation ${operationName} not found` }] };
  return executeOperation(doc, operation, variables);
}

/** POST /api/graphql: one operation object, or an array of them answered in order. Always HTTP 200. */
export async function handleGraphQL(rawBody: Buffer): Promise<Reply> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 200, body: { errors: [{ message: 'Invalid JSON in the request body' }] } };
  }
  if (Array.isArray(parsed)) return { status: 200, body: parsed.map((entry) => executeRequest(entry)) };
  return { status: 200, body: executeRequest(parsed) };
}
