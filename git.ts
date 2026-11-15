// The git object layer for the forge: SHA-1 object hashing, commit/tree/tag parsing and building,
// packfile reading (with OFS/REF delta resolution and thin-pack bases) and packfile writing.
// Pure Node built-ins only — the trial pod has no git binary and no package manager.
//
// Objects are stored decompressed as { type, data } where data is the raw object content (for a
// commit, the text after the "commit <n>\0" header). The object id is always recomputed from the
// content, never trusted from the wire.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

const CODE_TYPES: Readonly<Record<number, GitObjectType | 'ofs-delta' | 'ref-delta'>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
});

/** The object id git itself would compute: sha1 of "<type> <length>\0" followed by the content. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's content into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's content from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits and tags

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's content. Headers end at the first blank line; the rest is the message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's content. `authorLine` is the full "Name <email> ts tz" string. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
  extraHeaders?: readonly string[];
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  if (input.extraHeaders !== undefined) lines.push(...input.extraHeaders);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object's content. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Format an ident line: "Name <email> epoch tz". */
export function identLine(name: string, email: string, epochSec: number, tz = '+0000'): string {
  return `${name} <${email}> ${epochSec} ${tz}`;
}

/** The epoch seconds inside an ident line, or 0 when it does not parse. */
export function identEpoch(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident.trim());
  return match === null ? 0 : Number(match[1]);
}

// ------------------------------------------------------------------ deltas

/** Apply a git binary delta to `base`, returning the result. Throws on a malformed delta. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint overruns the buffer');
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, delta expects ${sourceSize}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) { copyOffset = delta[offset]; offset += 1; }
      if (opcode & 0x02) { copyOffset |= delta[offset] << 8; offset += 1; }
      if (opcode & 0x04) { copyOffset |= delta[offset] << 16; offset += 1; }
      if (opcode & 0x08) { copyOffset |= delta[offset] << 24; offset += 1; }
      if (opcode & 0x10) { copySize = delta[offset]; offset += 1; }
      if (opcode & 0x20) { copySize |= delta[offset] << 8; offset += 1; }
      if (opcode & 0x40) { copySize |= delta[offset] << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(parts);
  if (produced !== targetSize || result.length !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

// ------------------------------------------------------------------ packfiles

interface RawPackEntry {
  readonly kind: GitObjectType | 'ofs-delta' | 'ref-delta';
  readonly data: Buffer;
  readonly entryOffset: number;
  readonly baseOffset?: number;
  readonly baseOid?: string;
}

/** Inflate the zlib stream starting at `offset`; returns the bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Read one pack object header at `offset`: type, uncompressed size, and where the data starts. */
function readPackEntryHeader(buffer: Buffer, offset: number): { kind: GitObjectType | 'ofs-delta' | 'ref-delta'; size: number; dataOffset: number } {
  let byte = buffer[offset];
  let cursor = offset + 1;
  const code = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buffer[cursor];
    cursor += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  const kind = CODE_TYPES[code];
  if (kind === undefined) throw new Error(`unknown pack object type code ${code} at offset ${offset}`);
  return { kind, size, dataOffset: cursor };
}

/**
 * Parse a whole packfile into resolved objects. `lookupExternal` supplies thin-pack bases (objects
 * the sender assumed the receiver already holds); it is consulted only for REF_DELTA bases that are
 * not earlier in the same pack. Returns a map from object id to object. The trailer checksum is
 * verified before anything is resolved.
 */
export function readPack(
  pack: Buffer,
  lookupExternal?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('packfile is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('packfile does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`packfile version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!expected.equals(pack.subarray(trailerStart))) throw new Error('packfile checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.dataOffset;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.kind === 'ofs-delta') {
      let byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (header.kind === 'ref-delta') {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    offset = inflated.next;
    byOffset.set(entryOffset, raw.length);
    raw.push({ kind: header.kind, data: inflated.data, entryOffset, baseOffset, baseOid });
  }

  const resolved = new Map<string, GitObject>();
  const resolvedByIndex: (GitObject | undefined)[] = new Array(raw.length).fill(undefined);
  const resolve = (index: number, depth: number): GitObject => {
    const cached = resolvedByIndex[index];
    if (cached !== undefined) return cached;
    if (depth > 64) throw new Error('delta chain is too deep');
    const entry = raw[index];
    let object: GitObject;
    if (entry.kind === 'ofs-delta' || entry.kind === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.kind === 'ofs-delta') {
        const baseIndex = entry.baseOffset === undefined ? undefined : byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error(`ofs-delta at ${entry.entryOffset} names an unknown base offset`);
        base = resolve(baseIndex, depth + 1);
      } else {
        const baseId = entry.baseOid as string;
        base = resolved.get(baseId);
        if (base === undefined) {
          // The base may be a plain entry later in this pack: find it by scanning resolved ids is
          // not possible yet, so fall back to any pack entry whose content hashes to the base id.
          for (let scan = 0; scan < raw.length; scan += 1) {
            if (raw[scan].kind === 'ofs-delta' || raw[scan].kind === 'ref-delta') continue;
            const candidate = resolve(scan, depth + 1);
            if (hashObject(candidate.type, candidate.data) === baseId) { base = candidate; break; }
          }
        }
        if (base === undefined && lookupExternal !== undefined) base = lookupExternal(baseId);
        if (base === undefined) throw new Error(`ref-delta base ${baseId} is not available`);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.kind, data: entry.data };
    }
    resolvedByIndex[index] = object;
    resolved.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (let index = 0; index < raw.length; index += 1) resolve(index, 0);
  return resolved;
}

/** Encode one pack object header (type + size varint). */
function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Write a self-contained packfile holding `objects` (no deltas, never thin). Every object is
 * deflated whole; the trailer is the SHA-1 of everything before it.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `tips`: commits walk to their tree and parents, trees to their
 * entries, tags to their target. Missing objects are skipped (a partial walk for fetch haves).
 */
export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` through commit parents (inclusive). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * The merge base of two commits: the first commit met walking ancestors of `b` (breadth-first)
 * that is also an ancestor of `a`. Null when the histories share nothing.
 */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsOfA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    ancestorsOfA.add(oid);
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}
