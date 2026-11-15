// The git smart-HTTP surface: ref advertisement (protocol v2 and v0), ls-refs, fetch (upload-pack)
// and push (receive-pack), speaking the pkt-line dialect the suite's client implements. The store
// is in-memory; packs are written whole (no deltas, never thin) and read with full delta
// resolution, so any conforming client's bytes round-trip exactly.

import {
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { repoLookup, type Repo } from './store.ts';

// ------------------------------------------------------------------ pkt-lines

export const PKT_MAX_PAYLOAD = 65516;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktItem =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode a complete pkt-line stream; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) { items.push({ kind: 'flush' }); offset += 4; continue; }
    if (length === 1) { items.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { items.push({ kind: 'response-end' }); offset += 4; continue; }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
    items.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return items;
}

/** Wrap a byte stream in sideband band-1 pkt-lines (the packfile/report channel). */
export function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ refs

export interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly symrefTarget?: string;
  readonly peeled?: string;
  readonly unborn?: boolean;
}

/** Peel an oid through tag objects to the commit it ultimately names (or itself). */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/**
 * The forge's ref list in git's order: HEAD first (born or unborn), then refs sorted by name.
 * `peel` adds peeled targets for annotated tags; HEAD carries its symref target.
 */
export function listRefLines(repo: Repo, peel: boolean): RefLine[] {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const lines: RefLine[] = [];
  const headOid = repo.refs.get(headRef);
  if (headOid === undefined) lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headRef, unborn: true });
  else lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line.peeled = peelToCommit(repo, oid);
    }
    lines.push(line);
  }
  return lines;
}

// ------------------------------------------------------------------ advertisements

const AGENT = 'forge/1.0';

export function uploadPackCapsV2(): string[] {
  return ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
}

export function receivePackCaps(repo: Repo): string {
  return [
    'report-status',
    'delete-refs',
    'side-band-64k',
    'ofs-delta',
    'object-format=sha1',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
}

export function uploadPackCapsV0(repo: Repo): string {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'object-format=sha1',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
}

/** The v2 capability advertisement body for upload-pack. */
export function advertiseV2(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  for (const cap of uploadPackCapsV2()) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 ref advertisement body for either service. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack' ? receivePackCaps(repo) : uploadPackCapsV0(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = listRefLines(repo, true);
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    let first = true;
    for (const line of lines) {
      if (line.unborn) continue;
      let text = `${line.oid} ${line.name}`;
      if (first) {
        text += `\0${caps}`;
        first = false;
      }
      parts.push(pktLine(text));
      if (line.peeled !== undefined && line.peeled !== line.oid) {
        parts.push(pktLine(`${line.peeled} ${line.name}^{}`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

export interface LsRefsArgs {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: readonly string[];
}

export function runLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  for (const line of listRefLines(repo, args.peel)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
    if (line.unborn) {
      if (!args.unborn) continue;
      let text = `unborn ${line.name}`;
      if (args.symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
      parts.push(pktLine(`${text}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (args.symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (args.peel && line.peeled !== undefined && line.peeled !== line.oid) text += ` peeled:${line.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch computation

export interface FetchPlan {
  readonly objects: GitObject[];
  readonly objectIds: string[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly commonAcks: string[];
}

interface CommitGraph {
  readonly parentsOf: Map<string, readonly string[]>;
  readonly treeOf: Map<string, string>;
}

const graphCache = new WeakMap<Repo, { size: number; graph: CommitGraph }>();

/**
 * The commit graph over every commit in the repo (parents and trees). Objects are content-addressed
 * and only ever added, so the graph is cached per repo and rebuilt only when the object count moves:
 * a fetch-heavy workload (clones of a long history) must not re-parse every commit per request.
 */
function commitGraph(repo: Repo): CommitGraph {
  const cached = graphCache.get(repo);
  if (cached !== undefined && cached.size === repo.objects.size) return cached.graph;
  const parentsOf = new Map<string, readonly string[]>();
  const treeOf = new Map<string, string>();
  for (const [oid, object] of repo.objects) {
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    parentsOf.set(oid, commit.parents);
    treeOf.set(oid, commit.tree);
  }
  const graph: CommitGraph = { parentsOf, treeOf };
  graphCache.set(repo, { size: repo.objects.size, graph });
  return graph;
}

/** Min distance (in parent steps) from any want to every reachable commit; wants are distance 0. */
function distancesFrom(graph: CommitGraph, wants: readonly string[]): Map<string, number> {
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    if (graph.parentsOf.has(want) && !distance.has(want)) {
      distance.set(want, 0);
      queue.push(want);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const next = (distance.get(oid) as number) + 1;
    for (const parent of graph.parentsOf.get(oid) ?? []) {
      if (!distance.has(parent)) {
        distance.set(parent, next);
        queue.push(parent);
      }
    }
  }
  return distance;
}

/** Every object in the tree closure of the given trees (trees and blobs, recursively). */
function treeClosure(repo: Repo, treeOids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...treeOids];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTreeEntries(repo, oid)) stack.push(entry);
    }
  }
  return out;
}

function parseTreeEntries(repo: Repo, treeOid: string): string[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const oids: string[] = [];
  let offset = 0;
  const data = object.data;
  while (offset < data.length) {
    const nul = data.indexOf(0x00, offset);
    oids.push(data.toString('hex', nul + 1, nul + 21));
    offset = nul + 21;
  }
  return oids;
}

/**
 * Decide what a fetch sends. `haves` are commits the client holds in full; `clientShallow` are the
 * client's shallow boundary commits (held, but their parents are not); `depth` is the v2 `deepen`
 * argument (the depth from the wants, or the extension below the client's boundary).
 */
export function planFetch(
  repo: Repo,
  input: {
    wants: readonly string[];
    haves: readonly string[];
    clientShallow: readonly string[];
    depth?: number;
    deepenSince?: number;
    deepenNot?: readonly string[];
  },
): FetchPlan {
  const lookup = repoLookup(repo);
  const graph = commitGraph(repo);
  const shallowClient = new Set(input.clientShallow);
  const distance = distancesFrom(graph, input.wants);

  // The commits the client already holds in full: reachable from haves, but never descending
  // below a shallow boundary commit (its parents are not held).
  const heldCommits = new Set<string>();
  {
    const stack = [...input.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (heldCommits.has(oid) || !graph.parentsOf.has(oid)) continue;
      heldCommits.add(oid);
      if (shallowClient.has(oid)) continue;
      for (const parent of graph.parentsOf.get(oid) ?? []) stack.push(parent);
    }
  }

  // Which commits to include.
  const included = new Set<string>();
  let boundary = new Set<string>();
  if (input.depth === undefined) {
    for (const oid of distance.keys()) {
      if (!heldCommits.has(oid)) included.add(oid);
    }
  } else if (shallowClient.size === 0) {
    const limit = input.depth;
    for (const [oid, dist] of distance) {
      if (dist < limit) included.add(oid);
    }
    for (const oid of included) {
      const dist = distance.get(oid) as number;
      const parents = graph.parentsOf.get(oid) ?? [];
      if (dist === limit - 1 && parents.length > 0) boundary.add(oid);
    }
  } else {
    // Deepen relative to the client's boundary: include down to (depth - 1) generations below the
    // shallowest boundary commit, measured from the wants.
    let baseDist = Number.POSITIVE_INFINITY;
    for (const oid of shallowClient) {
      const dist = distance.get(oid);
      if (dist !== undefined && dist < baseDist) baseDist = dist;
    }
    if (!Number.isFinite(baseDist)) baseDist = 0;
    const limit = baseDist + input.depth - 1;
    for (const [oid, dist] of distance) {
      if (dist <= limit) included.add(oid);
    }
    for (const oid of included) {
      const parents = graph.parentsOf.get(oid) ?? [];
      const hasExcludedParent = parents.some((parent) => !included.has(parent) && graph.parentsOf.has(parent));
      if (hasExcludedParent) boundary.add(oid);
    }
  }

  // deepen-not prunes whole lines of history.
  if (input.deepenNot !== undefined && input.deepenNot.length > 0) {
    const pruned = new Set<string>();
    const stack = [...input.deepenNot];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (pruned.has(oid)) continue;
      pruned.add(oid);
      for (const parent of graph.parentsOf.get(oid) ?? []) stack.push(parent);
    }
    for (const oid of pruned) included.delete(oid);
  }

  // Objects: the included commits, their tree closures, plus any non-commit wants (tags) and
  // everything reachable from them that is not already held.
  const heldObjects = new Set<string>();
  for (const oid of heldCommits) {
    heldObjects.add(oid);
    const tree = graph.treeOf.get(oid);
    if (tree !== undefined) for (const inner of treeClosure(repo, [tree])) heldObjects.add(inner);
  }
  // Boundary commits the client holds shallow still hold their trees.
  for (const oid of shallowClient) {
    if (!heldCommits.has(oid)) {
      heldObjects.add(oid);
      const tree = graph.treeOf.get(oid);
      if (tree !== undefined) for (const inner of treeClosure(repo, [tree])) heldObjects.add(inner);
    }
  }

  const sendIds = new Set<string>();
  for (const oid of included) {
    if (!heldObjects.has(oid)) sendIds.add(oid);
    const tree = graph.treeOf.get(oid);
    if (tree !== undefined) for (const inner of treeClosure(repo, [tree])) if (!heldObjects.has(inner)) sendIds.add(inner);
  }
  // Non-commit wants (annotated tags and their targets).
  for (const want of input.wants) {
    if (graph.parentsOf.has(want)) continue;
    for (const oid of collectReachable([want], lookup)) {
      if (heldObjects.has(oid)) continue;
      if (included.size > 0 && lookup(oid)?.type === 'commit') continue;
      sendIds.add(oid);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of sendIds) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (input.depth !== undefined) {
    for (const oid of boundary) if (!heldCommits.has(oid) || included.has(oid)) shallow.push(oid);
    for (const oid of shallowClient) {
      const parents = graph.parentsOf.get(oid) ?? [];
      if (parents.length > 0 && parents.every((parent) => included.has(parent) || heldCommits.has(parent))) unshallow.push(oid);
      else if (included.has(oid) && !boundary.has(oid) && parents.length === 0) unshallow.push(oid);
    }
  }

  const commonAcks = input.haves.filter((have) => repo.objects.has(have));
  return { objects, objectIds: [...sendIds], shallow, unshallow, commonAcks };
}

// ------------------------------------------------------------------ request handling

export interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth?: number;
  readonly deepenSince?: number;
  readonly deepenNot: string[];
  readonly done: boolean;
}

/** Parse the argument lines of a v2 fetch command (after the delim). */
export function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [], done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) (args as { depth?: number }).depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) (args as { deepenSince?: number }).deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') (args as { done: boolean }).done = true;
  }
  return args;
}

/** Translate parsed fetch arguments into a fetch plan (FetchArgs.shallow is the client's boundary). */
function planOf(repo: Repo, args: FetchArgs): FetchPlan {
  return planFetch(repo, {
    wants: args.wants,
    haves: args.haves,
    clientShallow: args.shallow,
    depth: args.depth,
    deepenSince: args.deepenSince,
    deepenNot: args.deepenNot,
  });
}

/**
 * Whole-response cache for the clone shape (a depth fetch with no haves): the response is a pure
 * function of the refs, the wants and the depth — objects are immutable — so repeated clones of the
 * same tip are answered from memory. Keyed per repo under a fingerprint of the refs map, so any push
 * or ref write misses the cache and rebuilds.
 */
const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();

function fetchCacheKey(repo: Repo, args: FetchArgs): string | null {
  if (args.haves.length > 0 || args.shallow.length > 0) return null;
  if (args.depth === undefined || args.deepenSince !== undefined || args.deepenNot !== undefined) return null;
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, oid]) => `${ref}=${oid}`).join(' ');
  return `${refs}|${args.wants.join(',')}|${args.depth}`;
}

/** The v2 fetch response: acknowledgments, shallow-info, then the packfile in sideband band 1. */
export function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = fetchCacheKey(repo, args);
  if (cacheKey !== null) {
    const hit = fetchCache.get(repo)?.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  const plan = planOf(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.commonAcks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.commonAcks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(pktLine('ready\n'));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  if (cacheKey !== null) {
    let perRepo = fetchCache.get(repo);
    if (perRepo === undefined) {
      perRepo = new Map();
      fetchCache.set(repo, perRepo);
    }
    if (perRepo.size > 64) perRepo.clear();
    perRepo.set(cacheKey, response);
  }
  return response;
}

/** The v0 fetch response: shallow lines, NAK/ACK, then the sideband pack. */
export function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planOf(repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.commonAcks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.commonAcks) parts.push(pktLine(`ACK ${ack}\n`));
  const pack = writePack(plan.objects);
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

export interface PushCommandLine {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
  readonly capabilities: string[];
}

/** Split a receive-pack request body into its command list and the pack bytes that follow. */
export function parsePushBody(body: Buffer): { commands: PushCommandLine[]; pack: Buffer } {
  const commands: PushCommandLine[] = [];
  let offset = 0;
  let first = true;
  while (offset + 4 <= body.length) {
    const header = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) { offset += 4; break; }
    if (length < 4 || offset + length > body.length) throw new Error('malformed receive-pack command list');
    const payload = body.toString('utf8', offset + 4, offset + length).replace(/\n$/, '');
    offset += length;
    let caps: string[] = [];
    let line = payload;
    const nul = payload.indexOf('\0');
    if (nul >= 0) {
      line = payload.slice(0, nul);
      caps = payload.slice(nul + 1).split(' ').filter(Boolean);
    }
    const fields = line.split(' ');
    if (fields.length !== 3) throw new Error(`malformed push command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2], capabilities: first ? caps : [] });
    first = false;
  }
  return { commands, pack: body.subarray(offset) };
}

export interface PushOutcome {
  readonly unpackOk: boolean;
  readonly unpackDetail: string;
  readonly results: readonly { ref: string; ok: boolean; reason: string }[];
  readonly sideband: boolean;
}

/** Apply a push: unpack the pack, validate each command, move the refs that pass. */
export function applyPush(repo: Repo, commands: readonly PushCommandLine[], pack: Buffer): PushOutcome {
  const sideband = commands.length > 0 && (commands[0].capabilities.includes('side-band-64k'));
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    // A create/update with no pack at all is fine only when the objects are already present;
    // that is decided per-ref below.
    unpackOk = true;
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  const lookup = repoLookup(repo);
  for (const command of commands) {
    const fail = (reason: string): void => { results.push({ ref: command.ref, ok: false, reason }); };
    if (!unpackOk) { fail('unpacker error'); continue; }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) { fail('reference is not at the expected value'); continue; }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) { fail('missing object'); continue; }
    const isBranch = command.ref.startsWith('refs/heads/');
    const isTag = command.ref.startsWith('refs/tags/');
    if (isBranch && target.type !== 'commit') { fail('branch target is not a commit'); continue; }
    if (isTag && target.type !== 'commit' && target.type !== 'tag') { fail('tag target is not a commit or tag'); continue; }
    if (isBranch && command.oldOid !== ZERO_OID && target.type === 'commit') {
      if (!isAncestor(command.oldOid, command.newOid, lookup)) { fail('non-fast-forward'); continue; }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk, unpackDetail, results, sideband };
}

/** The report-status body for a push outcome, framed for the negotiated channel. */
export function pushReportBody(outcome: PushOutcome): Buffer {
  const parts: Buffer[] = [pktLine(`unpack ${outcome.unpackOk ? 'ok' : outcome.unpackDetail}\n`)];
  for (const result of outcome.results) {
    parts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  parts.push(PKT_FLUSH);
  const report = Buffer.concat(parts);
  if (!outcome.sideband) return report;
  return Buffer.concat([sidebandWrap(report), PKT_FLUSH]);
}

/** True when an oid string is a well-formed sha1 hex id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export { hashObject };
