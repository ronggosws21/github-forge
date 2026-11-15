// The MCP endpoint (POST /mcp): Model Context Protocol over streamable HTTP, speaking the current
// (2026-07-28) revision — `server/discover` answers the server's identity, capabilities and
// supported versions in one request, and every later request is a self-contained JSON-RPC call with
// no handshake and no session — plus the legacy `initialize` handshake for older clients. The tools
// are github-mcp-server's repository/issue/pull-request tools, executed against the same store the
// REST surface serves, so an object created over MCP is the same object over REST. Error discipline
// follows JSON-RPC: an unparseable body is HTTP 400 with -32700, an unknown tool or missing required
// arguments are -32602, an unknown method is -32601, and a tool that runs and fails answers a result
// with isError: true. Authentication is the HTTP layer's job (401 before this module runs).

import { store, VIEWER } from './store.ts';
import type { Repo, Issue, PullExtra } from './store.ts';
import {
  HttpError,
  repoJson,
  issueJson,
  pullJson,
  createIssue as restCreateIssue,
  createPull as restCreatePull,
  mergePull as restMergePull,
} from './rest.ts';
import type { Reply } from './app.ts';

const SERVER_INFO = Object.freeze({ name: 'forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const CAPABILITIES = Object.freeze({ tools: Object.freeze({}) });

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// --------------------------------------------------------------------------- tools

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
  readonly required: readonly string[];
}

const TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner (user login).' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner (user login).' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body (Markdown).' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    properties: {
      owner: { type: 'string', description: 'The repository owner (user login).' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner (user login).' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner (user login).' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body (Markdown).' },
      head: { type: 'string', description: 'The head branch (the branch with the changes).' },
      base: { type: 'string', description: 'The base branch (the branch to merge into).' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner (user login).' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'The merge method: merge, squash or rebase (default merge).' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
]);

/** The tools/list payload: one frozen array, so two calls answer byte for byte the same. */
const TOOLS = Object.freeze(
  TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(def.properties).map(([name, schema]) => [name, { type: schema.type, description: schema.description }]),
      ),
      required: [...def.required],
      additionalProperties: false,
    },
  })),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRepo(owner: unknown, name: unknown): Repo {
  const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : undefined;
  if (repo === undefined) throw new Error(`repository ${String(owner)}/${String(name)} not found`);
  return repo;
}

/** Run one tool; the return value becomes the result's structured content and text. Throws on failure. */
function runTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return repoJson(existing);
      const repo = store.createRepo({
        owner: VIEWER.login,
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    }
    case 'get_repo': {
      return repoJson(requireRepo(args.owner, args.repo));
    }
    case 'create_issue': {
      const repo = requireRepo(args.owner, args.repo);
      const issue = restCreateIssue(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = requireRepo(args.owner, args.repo);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.seq - b.seq);
      return issues.map((issue) => issueJson(repo, issue));
    }
    case 'get_issue': {
      const repo = requireRepo(args.owner, args.repo);
      const issue = typeof args.issue_number === 'number' ? repo.issues.get(args.issue_number) : undefined;
      if (issue === undefined || issue.isPull) throw new Error(`issue #${String(args.issue_number)} not found`);
      return issueJson(repo, issue);
    }
    case 'create_pull_request': {
      const repo = requireRepo(args.owner, args.repo);
      const created = restCreatePull(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : undefined,
        head: args.head as string,
        base: args.base as string,
      });
      return created.body;
    }
    case 'merge_pull_request': {
      const repo = requireRepo(args.owner, args.repo);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const issue: Issue | undefined = repo.issues.get(number);
      const pull: PullExtra | undefined = repo.pulls.get(number);
      if (issue === undefined || pull === undefined) throw new Error(`pull request #${String(args.pull_number)} not found`);
      const methodRaw = typeof args.merge_method === 'string' ? args.merge_method.toLowerCase() : 'merge';
      const method = methodRaw === 'squash' || methodRaw === 'rebase' ? methodRaw : 'merge';
      restMergePull(repo, issue, pull, method);
      return pullJson(repo, issue, pull);
    }
    default:
      return undefined; // unreachable: the caller checks the name first
  }
}

// --------------------------------------------------------------------------- JSON-RPC plumbing

interface RpcError {
  readonly code: number;
  readonly message: string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: error.code, message: error.message } };
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: CAPABILITIES,
    serverInfo: { ...SERVER_INFO },
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

function handleRequest(request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, { code: INVALID_REQUEST, message: 'Invalid Request: method must be a string' });
  const params = isRecord(request.params) ? request.params : {};
  const isNotification = id === undefined;
  const answer = (result: unknown): Record<string, unknown> | null => (isNotification ? null : rpcResult(id, result));
  const failWith = (error: RpcError): Record<string, unknown> | null => (isNotification ? null : rpcError(id, error));

  switch (method) {
    case 'server/discover':
      return answer(discoverResult());
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return answer({ protocolVersion, capabilities: CAPABILITIES, serverInfo: { ...SERVER_INFO } });
    }
    case 'ping':
      return answer({});
    case 'tools/list':
      return answer({ tools: TOOLS });
    case 'resources/list':
      return answer({ resources: [] });
    case 'prompts/list':
      return answer({ prompts: [] });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') return failWith({ code: INVALID_PARAMS, message: 'tools/call needs a tool name' });
      const def = TOOL_DEFS.find((tool) => tool.name === name);
      if (def === undefined) return failWith({ code: INVALID_PARAMS, message: `Unknown tool: ${name}` });
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = def.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return failWith({ code: INVALID_PARAMS, message: `Missing required argument(s) for ${name}: ${missing.join(', ')}` });
      }
      try {
        const value = runTool(name, args);
        const text = JSON.stringify(value) ?? '';
        return answer({ content: [{ type: 'text', text }], structuredContent: value, isError: false });
      } catch (err) {
        const message = err instanceof HttpError || err instanceof Error ? err.message : String(err);
        return answer({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return failWith({ code: METHOD_NOT_FOUND, message: `Method not found: ${method}` });
  }
}

/** POST /mcp: one JSON-RPC request (or a batch array); notifications answer an empty 200. */
export async function handleMcp(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<Reply> {
  void headers;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, { code: PARSE_ERROR, message: 'Parse error: the body is not valid JSON' }) };
  }
  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const response = handleRequest(entry);
      if (response !== null) responses.push(response);
    }
    return { status: 200, body: responses };
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
    return { status: 200, body: rpcError(isRecord(parsed) ? parsed.id : null, { code: INVALID_REQUEST, message: 'Invalid Request: expected a JSON-RPC 2.0 request' }) };
  }
  const response = handleRequest(parsed);
  if (response === null) return { status: 200, body: null };
  return { status: 200, body: response };
}
