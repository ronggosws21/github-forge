// The REST v3 surface: repositories, branches, commits, contents, git refs, labels, issues,
// comments and pull requests, in GitHub's shapes and with GitHub's status codes. Serializers are
// exported because the GraphQL and MCP surfaces present the same objects.

import { identEpoch, isAncestor, mergeBase, parseCommit, parseTree, type GitObject } from './git.ts';
import {
  commitFileChange,
  commitTreeOid,
  createCommit,
  diffTrees,
  fileAtPath,
  flattenTree,
  mergeTrees,
  nowIso,
  putObject,
  refOid,
  repoLookup,
  store,
  VIEWER,
  type Issue,
  type IssueComment,
  type LabelInfo,
  type PullExtra,
  type Repo,
  type UserInfo,
} from './store.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

// ------------------------------------------------------------------ serializers

export function userJson(user: UserInfo): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(VIEWER),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function labelJson(label: LabelInfo): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelInfo => label !== undefined)
      .map(labelJson),
    user: userJson(issue.user),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
  if (issue.isPull) {
    json.pull_request = { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}` };
  }
  return json;
}

export function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo: Repo, issue: Issue, pull: PullExtra): Record<string, unknown> {
  const headSha = refOid(repo, `refs/heads/${pull.headRef}`) ?? pull.headOid;
  const baseSha = refOid(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseOid;
  return {
    id: issue.id,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body ?? '',
    user: userJson(issue.user),
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelInfo => label !== undefined)
      .map(labelJson),
    draft: pull.draft,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: userJson(VIEWER), repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userJson(VIEWER), repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    mergeable_state: 'unknown',
    comments: issue.comments.length,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid) as GitObject;
  const commit = parseCommit(object.data);
  const authorEpoch = identEpoch(commit.author);
  const committerEpoch = identEpoch(commit.committer);
  const splitIdent = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(ident.trim());
    const epoch = ident === commit.author ? authorEpoch : committerEpoch;
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: new Date(epoch * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    commit: {
      author: splitIdent(commit.author),
      committer: splitIdent(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: userJson(VIEWER),
    committer: userJson(VIEWER),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ shared helpers

export interface Page {
  readonly page: number;
  readonly perPage: number;
}

export function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { page, perPage };
}

export function pageSlice<T>(items: readonly T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

/** The Link header for a page of a list, or null when there is only one page. */
export function linkHeader(url: URL, page: Page, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  if (lastPage <= 1) return null;
  const withPage = (target: number): string => {
    const copy = new URL(url.toString());
    copy.searchParams.set('page', String(target));
    copy.searchParams.set('per_page', String(page.perPage));
    return copy.toString();
  };
  const parts: string[] = [];
  if (page.page < lastPage) {
    parts.push(`<${withPage(page.page + 1)}>; rel="next"`);
    parts.push(`<${withPage(lastPage)}>; rel="last"`);
  }
  if (page.page > 1) {
    parts.push(`<${withPage(1)}>; rel="first"`);
    parts.push(`<${withPage(page.page - 1)}>; rel="prev"`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

export function requireRepo(owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw notFound();
  return repo;
}

type Json = Record<string, unknown>;

function bodyString(body: Json, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

// ------------------------------------------------------------------ repositories

export function createRepo(body: Json): { status: number; body: unknown } {
  const name = bodyString(body, 'name');
  if (name === undefined || name === '') throw new HttpError(422, 'Validation Failed: name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new HttpError(422, 'Validation Failed: name is invalid');
  if (store.getRepo(VIEWER.login, name) !== undefined) {
    throw new HttpError(422, `Validation Failed: name already exists on this account`);
  }
  const repo = store.createRepo({
    owner: VIEWER.login,
    name,
    description: bodyString(body, 'description') ?? '',
    isPrivate: typeof body.private === 'boolean' ? body.private : false,
    defaultBranch: bodyString(body, 'default_branch') ?? 'main',
  });
  return { status: 201, body: repoJson(repo) };
}

export function patchRepo(repo: Repo, body: Json): Record<string, unknown> {
  const description = bodyString(body, 'description');
  if (description !== undefined) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const defaultBranch = bodyString(body, 'default_branch');
  if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
  const name = bodyString(body, 'name');
  if (name !== undefined && name !== '' && name !== repo.name) {
    store.repos.delete(store.repoKey(repo.owner, repo.name));
    repo.name = name;
    store.repos.set(store.repoKey(repo.owner, repo.name), repo);
  }
  repo.updatedAt = nowIso();
  return repoJson(repo);
}

export function listBranches(repo: Repo): Record<string, unknown>[] {
  return [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid },
      protected: false,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Commits reachable from `startOid`, newest first (depth-first pre-order, parents in order). */
export function listCommits(repo: Repo, startOid: string): Record<string, unknown>[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [startOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]);
  }
  return order.map((oid) => commitJson(repo, oid));
}

// ------------------------------------------------------------------ contents

export function getContents(repo: Repo, path: string, ref: string | undefined): unknown {
  const branch = ref ?? repo.defaultBranch;
  const tip = refOid(repo, `refs/heads/${branch}`);
  if (tip === undefined) throw notFound();
  const tree = commitTreeOid(repo, tip);
  if (tree === undefined) throw notFound();
  if (path === '') {
    return directoryListing(repo, tree, '');
  }
  const entry = fileAtPath(repo, tree, path);
  if (entry === undefined) throw notFound();
  if (entry.mode === '40000' || entry.mode === '040000') {
    return directoryListing(repo, entry.oid, path);
  }
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined) throw notFound();
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: path.split('/').pop(),
    path,
    content: blob.data.toString('base64'),
    sha: entry.oid,
  };
}

function directoryListing(repo: Repo, treeOid: string, basePath: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') throw notFound();
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const target = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
      sha: entry.oid,
      size: isDir ? 0 : (target?.data.length ?? 0),
    };
  });
}

export function putContents(repo: Repo, path: string, body: Json): { status: number; body: unknown } {
  const message = bodyString(body, 'message');
  const contentB64 = bodyString(body, 'content');
  if (message === undefined || contentB64 === undefined) throw new HttpError(422, 'Validation Failed: message and content are required');
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const tree = tip === undefined ? undefined : commitTreeOid(repo, tip);
  const existing = tree === undefined ? undefined : fileAtPath(repo, tree, path);
  const sha = bodyString(body, 'sha');
  if (existing !== undefined && existing.mode !== '40000' && existing.mode !== '040000') {
    if (sha !== existing.oid) {
      throw new HttpError(409, `${path} does not match the current blob sha`);
    }
  }
  const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = putObject(repo, 'blob', data);
  const commit = commitFileChange(repo, branch, path, blobOid, message);
  repo.updatedAt = nowIso();
  return {
    status: existing === undefined ? 201 : 200,
    body: {
      content: {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        sha: blobOid,
      },
      commit: { sha: commit, message },
    },
  };
}

export function deleteContents(repo: Repo, path: string, body: Json): unknown {
  const message = bodyString(body, 'message');
  if (message === undefined) throw new HttpError(422, 'Validation Failed: message is required');
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) throw notFound();
  const tree = commitTreeOid(repo, tip);
  const existing = tree === undefined ? undefined : fileAtPath(repo, tree, path);
  if (existing === undefined || existing.mode === '40000' || existing.mode === '040000') throw notFound();
  const sha = bodyString(body, 'sha');
  if (sha !== undefined && sha !== existing.oid) throw new HttpError(409, `${path} does not match the current blob sha`);
  const commit = commitFileChange(repo, branch, path, null, message);
  repo.updatedAt = nowIso();
  return { content: null, commit: { sha: commit, message } };
}

// ------------------------------------------------------------------ git refs

export function createGitRef(repo: Repo, body: Json): { status: number; body: unknown } {
  const ref = bodyString(body, 'ref');
  const sha = bodyString(body, 'sha');
  if (ref === undefined || sha === undefined) throw new HttpError(422, 'Validation Failed: ref and sha are required');
  const target = repo.objects.get(sha);
  if (target === undefined) throw new HttpError(422, 'Validation Failed: sha does not name an object');
  if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, object: { sha, type: target.type } } };
}

// ------------------------------------------------------------------ labels

export function createLabel(repo: Repo, body: Json): { status: number; body: unknown } {
  const name = bodyString(body, 'name');
  if (name === undefined || name === '') throw new HttpError(422, 'Validation Failed: name is required');
  if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: name has already been taken');
  const label: LabelInfo = {
    id: store.newLabelId(),
    name,
    color: (bodyString(body, 'color') ?? 'ededed').replace(/^#/, ''),
    description: bodyString(body, 'description') ?? null,
  };
  repo.labels.set(name, label);
  return { status: 201, body: labelJson(label) };
}

// ------------------------------------------------------------------ issues and comments

export interface IssueInput {
  title?: string;
  body?: string | null;
  labels?: string[];
  state?: string;
}

export function validateLabels(repo: Repo, labels: readonly string[]): void {
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
  }
}

export function createIssue(repo: Repo, input: IssueInput): Issue {
  const title = input.title;
  if (title === undefined || title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const labels = input.labels ?? [];
  validateLabels(repo, labels);
  const stamp = nowIso();
  const issue: Issue = {
    id: store.newIssueId(),
    number: repo.nextNumber++,
    title,
    body: input.body ?? null,
    state: 'open',
    labels: [...labels],
    user: VIEWER,
    comments: [],
    isPull: false,
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    seq: 0,
  };
  issue.seq = issue.number;
  repo.issues.set(issue.number, issue);
  repo.updatedAt = stamp;
  return issue;
}

export function listIssues(repo: Repo, query: URLSearchParams): Issue[] {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  return issues;
}

export function patchIssue(repo: Repo, issue: Issue, body: Json): Issue {
  const title = bodyString(body, 'title');
  if (title !== undefined) issue.title = title;
  if ('body' in body) issue.body = typeof body.body === 'string' ? body.body : null;
  const labels = body.labels;
  if (Array.isArray(labels)) {
    const names = labels.filter((name): name is string => typeof name === 'string');
    validateLabels(repo, names);
    issue.labels = names;
  }
  const state = bodyString(body, 'state');
  if (state === 'closed' || state === 'open') {
    issue.state = state;
    issue.closedAt = state === 'closed' ? nowIso() : null;
  }
  issue.updatedAt = nowIso();
  return issue;
}

export function addComment(repo: Repo, issue: Issue, body: Json): IssueComment {
  const text = bodyString(body, 'body');
  if (text === undefined) throw new HttpError(422, 'Validation Failed: body is required');
  const stamp = nowIso();
  const comment: IssueComment = { id: store.newCommentId(), body: text, user: VIEWER, createdAt: stamp, updatedAt: stamp };
  issue.comments.push(comment);
  issue.updatedAt = stamp;
  return comment;
}

// ------------------------------------------------------------------ pull requests

export function createPull(repo: Repo, body: Json): { status: number; body: unknown } {
  const title = bodyString(body, 'title');
  const headRaw = bodyString(body, 'head');
  const baseRaw = bodyString(body, 'base');
  if (title === undefined || headRaw === undefined || baseRaw === undefined) {
    throw new HttpError(422, 'Validation Failed: title, head and base are required');
  }
  const head = headRaw.includes(':') ? headRaw.split(':').pop() as string : headRaw;
  const base = baseRaw.includes(':') ? baseRaw.split(':').pop() as string : baseRaw;
  const headOid = refOid(repo, `refs/heads/${head}`);
  const baseOid = refOid(repo, `refs/heads/${base}`);
  if (headOid === undefined) throw new HttpError(422, `Validation Failed: head branch "${head}" does not exist`);
  if (baseOid === undefined) throw new HttpError(422, `Validation Failed: base branch "${base}" does not exist`);
  if (headOid === baseOid) throw new HttpError(422, 'Validation Failed: head and base are the same commit');
  const stamp = nowIso();
  const issue: Issue = {
    id: store.newIssueId(),
    number: repo.nextNumber++,
    title,
    body: bodyString(body, 'body') ?? null,
    state: 'open',
    labels: [],
    user: VIEWER,
    comments: [],
    isPull: true,
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    seq: 0,
  };
  issue.seq = issue.number;
  const pull: PullExtra = {
    headRef: head,
    headOid,
    baseRef: base,
    baseOid,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    draft: body.draft === true,
  };
  repo.issues.set(issue.number, issue);
  repo.pulls.set(issue.number, pull);
  repo.updatedAt = stamp;
  return { status: 201, body: pullJson(repo, issue, pull) };
}

export function pullFiles(repo: Repo, pull: PullExtra): ReturnType<typeof diffTrees> {
  const lookup = repoLookup(repo);
  const headOid = refOid(repo, `refs/heads/${pull.headRef}`) ?? pull.headOid;
  const baseOid = refOid(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseOid;
  const base = mergeBase(baseOid, headOid, lookup) ?? baseOid;
  return diffTrees(repo, commitTreeOid(repo, base), commitTreeOid(repo, headOid));
}

export interface MergeResult {
  readonly sha: string;
}

/** Merge a pull request into its base branch with the named method. Throws 405 on a conflict. */
export function mergePull(repo: Repo, issue: Issue, pull: PullExtra, method: string, commitTitle?: string): MergeResult {
  if (pull.merged) throw new HttpError(405, 'Pull Request already merged');
  if (issue.state === 'closed') throw new HttpError(405, 'Pull Request is closed');
  const lookup = repoLookup(repo);
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseOid = repo.refs.get(baseRef);
  const headOid = refOid(repo, `refs/heads/${pull.headRef}`) ?? pull.headOid;
  if (baseOid === undefined || headOid === undefined) throw new HttpError(405, 'Pull Request is not mergeable');
  const base = mergeBase(baseOid, headOid, lookup);
  if (base === null || base === headOid) throw new HttpError(405, 'Pull Request is not mergeable');
  const merged = mergeTrees(repo, commitTreeOid(repo, base), commitTreeOid(repo, baseOid), commitTreeOid(repo, headOid));
  if (!merged.ok || merged.tree === undefined) {
    throw new HttpError(405, `Pull Request is not mergeable: conflict in ${merged.conflictPath ?? 'a file'}`);
  }
  let sha: string;
  if (method === 'squash') {
    const message = commitTitle ?? `${issue.title} (#${issue.number})`;
    sha = createCommit(repo, { tree: merged.tree, parents: [baseOid], message });
  } else if (method === 'rebase') {
    // Replay the head's own commits (oldest first) onto the base tip.
    const chain: string[] = [];
    const seen = new Set<string>();
    const stack = [headOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === base || seen.has(oid)) continue;
      seen.add(oid);
      chain.push(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
    }
    chain.reverse();
    let current = baseOid;
    let currentTree = commitTreeOid(repo, baseOid);
    for (const oid of chain) {
      const commit = parseCommit((repo.objects.get(oid) as GitObject).data);
      const parentTree = commit.parents.length > 0 ? commitTreeOid(repo, commit.parents[0]) : undefined;
      const step = mergeTrees(repo, parentTree, currentTree, commit.tree);
      if (!step.ok || step.tree === undefined) throw new HttpError(405, 'Pull Request is not mergeable');
      current = createCommit(repo, { tree: step.tree, parents: [current], message: commit.message });
      currentTree = step.tree;
    }
    sha = current;
  } else {
    const message = `Merge pull request #${issue.number} from ${pull.headRef}\n\n${issue.title}`;
    sha = createCommit(repo, { tree: merged.tree, parents: [baseOid, headOid], message });
  }
  repo.refs.set(baseRef, sha);
  const stamp = nowIso();
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = sha;
  issue.state = 'closed';
  issue.closedAt = stamp;
  issue.updatedAt = stamp;
  repo.updatedAt = stamp;
  return { sha };
}

export { isAncestor };
