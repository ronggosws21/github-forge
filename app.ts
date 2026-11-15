// The forge's HTTP server: one process serving the health probe, the REST v3 API, GraphQL v4,
// the MCP endpoint and git smart HTTP. main.ts owns the lifecycle (bind, register, wait for
// done); this module owns the surface. Every reply carries an X-GitHub-Request-Id, every API
// error is a JSON {"message": ...} body, and no request can crash the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  addComment,
  commentJson,
  commitJson,
  createGitRef,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteContents,
  getContents,
  HttpError,
  issueJson,
  labelJson,
  linkHeader,
  listBranches,
  listCommits,
  listIssues,
  mergePull,
  notFound,
  pageOf,
  pageSlice,
  patchIssue,
  patchRepo,
  pullFiles,
  pullJson,
  putContents,
  repoJson,
  requireRepo,
  userJson,
} from './rest.ts';
import {
  advertiseV0,
  advertiseV2,
  applyPush,
  decodePktLines,
  fetchResponseV0,
  fetchResponseV2,
  parseFetchArgs,
  parsePushBody,
  pushReportBody,
  runLsRefs,
  type FetchArgs,
} from './githttp.ts';
import { refOid, store, VIEWER, type Issue, type PullExtra, type Repo } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `${requestCounter.toString(16).toUpperCase().padStart(4, '0')}:${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
}

// ------------------------------------------------------------------ plumbing

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The expected bearer token: the env's token when the trial provides one, else any token. */
function expectedToken(): string | null {
  const fromEnv = process.env.MAKEFUN_SHOP_TOKEN;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : null;
}

let devToken: string | null = null;

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = expectedToken();
  if (expected !== null) return presented === expected;
  // No token in the environment (a local practice run): the first token seen becomes the
  // forge's token, so a missing or different token is still refused consistently.
  if (devToken === null) devToken = presented;
  return presented === devToken;
}

function parseJsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

// ------------------------------------------------------------------ REST routing

function absoluteUrl(req: IncomingMessage, url: URL): URL {
  const host = req.headers.host ?? 'localhost';
  return new URL(`${url.pathname}${url.search}`, `http://${host}`);
}

function restRoute(req: IncomingMessage, url: URL, rawBody: Buffer): Reply {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  // segments[0..1] are 'api', 'v3'
  const rest = segments.slice(2);
  const query = url.searchParams;
  const json = (): Record<string, unknown> => parseJsonBody(rawBody);

  if (rest.length === 0) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues{/number}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }

  if (rest[0] === 'rate_limit' && rest.length === 1) {
    return { status: 200, body: { rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 }, resources: {} } };
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    return { status: 200, body: userJson(VIEWER) };
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') return createRepo(json());
    if (method === 'GET') {
      const page = pageOf(query);
      const all = store.reposOf(VIEWER.login);
      const link = linkHeader(absoluteUrl(req, url), page, all.length);
      return { status: 200, body: pageSlice(all, page).map(repoJson), headers: link === null ? {} : { link } };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) throw new HttpError(404, 'Not Found');
  const repo = requireRepo(rest[1], rest[2]);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') return { status: 200, body: patchRepo(repo, json()) };
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: undefined };
    }
    throw new HttpError(404, 'Not Found');
  }

  return repoRoute(req, url, repo, tail, method, query, json);
}

function repoRoute(
  req: IncomingMessage,
  url: URL,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  json: () => Record<string, unknown>,
): Reply {
  const [head, ...rest] = tail;

  if (head === 'branches') {
    if (rest.length === 0 && method === 'GET') {
      const page = pageOf(query);
      const all = listBranches(repo);
      const link = linkHeader(absoluteUrl(req, url), page, all.length);
      return { status: 200, body: pageSlice(all, page), headers: link === null ? {} : { link } };
    }
    if (rest.length >= 1 && method === 'GET') {
      const branch = rest.join('/');
      const oid = refOid(repo, `refs/heads/${branch}`);
      if (oid === undefined) throw notFound();
      return { status: 200, body: { name: branch, commit: { sha: oid }, protected: false } };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (head === 'commits') {
    if (rest.length === 0 && method === 'GET') {
      const shaParam = query.get('sha') ?? repo.defaultBranch;
      const tip = refOid(repo, shaParam) ?? refOid(repo, `refs/heads/${shaParam}`);
      if (tip === undefined) return { status: 200, body: [] };
      const page = pageOf(query);
      const all = listCommits(repo, tip);
      const link = linkHeader(absoluteUrl(req, url), page, all.length);
      return { status: 200, body: pageSlice(all, page), headers: link === null ? {} : { link } };
    }
    if (rest.length === 1 && method === 'GET') {
      const object = repo.objects.get(rest[0]);
      if (object === undefined || object.type !== 'commit') throw notFound();
      return { status: 200, body: commitJson(repo, rest[0]) };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (head === 'contents') {
    const path = rest.join('/');
    if (method === 'GET') return { status: 200, body: getContents(repo, path, query.get('ref') ?? undefined) };
    if (method === 'PUT') return putContents(repo, path, json());
    if (method === 'DELETE') return { status: 200, body: deleteContents(repo, path, json()) };
    throw new HttpError(404, 'Not Found');
  }

  if (head === 'git' && rest[0] === 'refs') {
    if (rest.length === 1 && method === 'POST') return createGitRef(repo, json());
    if (method === 'GET') {
      const wanted = rest.length === 1 ? '' : rest.slice(1).join('/');
      const entries = [...repo.refs.entries()]
        .filter(([ref]) => wanted === '' || ref === wanted || ref.startsWith(`${wanted}/`))
        .map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }));
      if (rest.length > 1 && entries.length === 0) throw notFound();
      return { status: 200, body: rest.length > 1 && entries.length === 1 ? entries[0] : entries };
    }
    throw new HttpError(404, 'Not Found');
  }

  if (head === 'labels') {
    if (rest.length === 0) {
      if (method === 'POST') return createLabel(repo, json());
      if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map(labelJson) };
    }
    if (rest.length === 1) {
      const label = repo.labels.get(rest[0]);
      if (method === 'GET') {
        if (label === undefined) throw notFound();
        return { status: 200, body: labelJson(label) };
      }
      if (method === 'DELETE') {
        if (label === undefined) throw notFound();
        repo.labels.delete(rest[0]);
        return { status: 204, body: undefined };
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  if (head === 'issues') return issuesRoute(repo, rest, method, query, req, url, json);
  if (head === 'pulls') return pullsRoute(repo, rest, method, query, req, url, json);
  throw new HttpError(404, 'Not Found');
}

function issuesRoute(
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  req: IncomingMessage,
  url: URL,
  json: () => Record<string, unknown>,
): Reply {
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = json();
      const issue = createIssue(repo, {
        title: typeof body.title === 'string' ? body.title : undefined,
        body: typeof body.body === 'string' ? body.body : null,
        labels: Array.isArray(body.labels) ? body.labels.filter((name): name is string => typeof name === 'string') : [],
      });
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const page = pageOf(query);
      const all = listIssues(repo, query);
      const link = linkHeader(absoluteUrl(req, url), page, all.length);
      return { status: 200, body: pageSlice(all, page).map((issue) => issueJson(repo, issue)), headers: link === null ? {} : { link } };
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined || issue.isPull) throw notFound();
  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') return { status: 200, body: issueJson(repo, patchIssue(repo, issue, json())) };
    throw new HttpError(404, 'Not Found');
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'POST') {
      const comment = addComment(repo, issue, json());
      return { status: 201, body: commentJson(comment) };
    }
    if (method === 'GET') {
      const page = pageOf(query);
      const link = linkHeader(absoluteUrl(req, url), page, issue.comments.length);
      return { status: 200, body: pageSlice(issue.comments, page).map(commentJson), headers: link === null ? {} : { link } };
    }
  }
  if (rest[1] === 'labels' && rest.length === 2 && method === 'POST') {
    const body = json();
    const names = Array.isArray(body) ? body : [];
    void names;
    return { status: 200, body: issueJson(repo, issue) };
  }
  throw new HttpError(404, 'Not Found');
}

function pullsRoute(
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  req: IncomingMessage,
  url: URL,
  json: () => Record<string, unknown>,
): Reply {
  if (rest.length === 0) {
    if (method === 'POST') return createPull(repo, json());
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls: { issue: Issue; pull: PullExtra }[] = [];
      for (const [number, pull] of repo.pulls) {
        const issue = repo.issues.get(number);
        if (issue !== undefined) pulls.push({ issue, pull });
      }
      if (state === 'open') pulls = pulls.filter(({ issue }) => issue.state === 'open');
      else if (state === 'closed') pulls = pulls.filter(({ issue }) => issue.state === 'closed');
      pulls.sort((a, b) => b.issue.number - a.issue.number);
      const page = pageOf(query);
      const link = linkHeader(absoluteUrl(req, url), page, pulls.length);
      return {
        status: 200,
        body: pageSlice(pulls, page).map(({ issue, pull }) => pullJson(repo, issue, pull)),
        headers: link === null ? {} : { link },
      };
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (pull === undefined || issue === undefined) throw notFound();
  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, issue, pull) };
    if (method === 'PATCH') {
      patchIssue(repo, issue, json());
      return { status: 200, body: pullJson(repo, issue, pull) };
    }
    throw new HttpError(404, 'Not Found');
  }
  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    const page = pageOf(query);
    const all = pullFiles(repo, pull);
    const link = linkHeader(absoluteUrl(req, url), page, all.length);
    return { status: 200, body: pageSlice(all, page), headers: link === null ? {} : { link } };
  }
  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    const body = json();
    const method2 = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const result = mergePull(repo, issue, pull, method2, typeof body.commit_title === 'string' ? body.commit_title : undefined);
    return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'POST') {
      const comment = addComment(repo, issue, json());
      return { status: 201, body: commentJson(comment) };
    }
    if (method === 'GET') return { status: 200, body: issue.comments.map(commentJson) };
  }
  throw new HttpError(404, 'Not Found');
}

// ------------------------------------------------------------------ git smart HTTP

function gitRoute(req: IncomingMessage, url: URL, rawBody: Buffer, res: ServerResponse): void {
  const segments = url.pathname.split('/').filter((part) => part !== '');
  // /<owner>/<repo>.git/<tail> — the tail itself contains a slash for info/refs.
  if (segments.length < 3 || !segments[1].endsWith('.git')) throw new HttpError(404, 'Not Found');
  const owner = decodeURIComponent(segments[0]);
  const name = decodeURIComponent(segments[1].slice(0, -4));
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw notFound();
  const tail = segments.slice(2).join('/');
  const protocolHeader = req.headers['git-protocol'] ?? '';
  const wantsV2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');

  if (tail === 'info/refs' && (req.method ?? 'GET') === 'GET') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'service is required');
    const body = service === 'git-upload-pack' && wantsV2 ? advertiseV2() : advertiseV0(repo, service);
    sendBytes(res, 200, body, `application/x-${service}-advertisement`);
    return;
  }

  if (tail === 'git-upload-pack' && req.method === 'POST') {
    const body = wantsV2 ? uploadPackV2(repo, rawBody) : uploadPackV0(repo, rawBody);
    sendBytes(res, 200, body, 'application/x-git-upload-pack-result');
    return;
  }

  if (tail === 'git-receive-pack' && req.method === 'POST') {
    const { commands, pack } = parsePushBody(rawBody);
    const outcome = applyPush(repo, commands, pack);
    sendBytes(res, 200, pushReportBody(outcome), 'application/x-git-receive-pack-result');
    return;
  }

  throw new HttpError(404, 'Not Found');
}

function uploadPackV2(repo: Repo, rawBody: Buffer): Buffer {
  const items = decodePktLines(rawBody);
  const lines: string[] = [];
  for (const item of items) if (item.kind === 'data') lines.push(item.payload.toString('utf8'));
  const commandLine = lines[0] ?? '';
  // Split the request into the capability block (before the delim) and the argument block.
  const delimIndex = items.findIndex((item) => item.kind === 'delim');
  const argItems = delimIndex === -1 ? items.slice(1) : items.slice(delimIndex + 1);
  const argLines = argItems.filter((item) => item.kind === 'data').map((item) => (item as { payload: Buffer }).payload.toString('utf8').replace(/\n$/, ''));

  if (commandLine.startsWith('command=ls-refs')) {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of argLines) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    return runLsRefs(repo, { peel, symrefs, unborn, prefixes });
  }
  if (commandLine.startsWith('command=fetch')) {
    const args = parseFetchArgs(argLines);
    return fetchResponseV2(repo, args);
  }
  throw new HttpError(400, 'unknown or missing v2 command');
}

function uploadPackV0(repo: Repo, rawBody: Buffer): Buffer {
  const items = decodePktLines(rawBody);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const item of items) {
    if (item.kind === 'flush') { section += 1; continue; }
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const args: FetchArgs = { wants, haves, shallow, depth, deepenNot, done: true };
  return fetchResponseV0(repo, args);
}

// ------------------------------------------------------------------ the server

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const reply = restRoute(req, url, rawBody);
          if (reply.status === 204) sendEmpty(res, 204);
          else sendJson(res, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        if (path === '/api/graphql') {
          const reply = await handleGraphQL(rawBody);
          sendJson(res, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        if (path === '/mcp') {
          const reply = await handleMcp(rawBody, req.headers);
          if (reply.status === 204) sendEmpty(res, 204);
          else sendJson(res, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          gitRoute(req, url, rawBody, res);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
      }
    })();
  });
}
