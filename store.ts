// The forge's in-memory store: users, repositories (git objects + refs), issues, comments, labels
// and pull requests, plus the repository operations the surfaces share (tree editing, file diffs,
// three-way merges). Nothing persists — a trial starts the process fresh and the suite builds
// every repository it inspects through the API itself.

import {
  buildCommit,
  buildTree,
  hashObject,
  identLine,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export interface UserInfo {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The token's owner: the one authenticated user of this forge. */
export const VIEWER: UserInfo = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface LabelInfo {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  user: UserInfo;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: UserInfo;
  comments: IssueComment[];
  isPull: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface PullExtra {
  headRef: string;
  headOid: string;
  baseRef: string;
  baseOid: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  draft: boolean;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullExtra>;
  labels: Map<string, LabelInfo>;
  nextNumber: number;
}

// A monotonic clock: every timestamp the forge issues is strictly later than the previous one, so
// created-order sorts are exact even when several objects are born inside the same millisecond.
let lastMs = Date.now();
export function nowIso(): string {
  const now = Date.now();
  lastMs = now > lastMs ? now : lastMs + 1;
  return new Date(lastMs).toISOString();
}

export function nowEpochSec(): number {
  return Math.floor(Date.parse(nowIso()) / 1000);
}

let repoIdCounter = 100_000;
let issueIdCounter = 1_000_000;
let commentIdCounter = 5_000_000;
let labelIdCounter = 7_000_000;
let seqCounter = 0;

export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export class Store {
  readonly repos = new Map<string, Repo>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(input: { owner: string; name: string; description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const stamp = nowIso();
    const repo: Repo = {
      id: repoIdCounter++,
      owner: input.owner,
      name: input.name,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: input.defaultBranch ?? 'main',
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  newIssueId(): number {
    issueIdCounter += 1;
    return issueIdCounter;
  }

  newCommentId(): number {
    commentIdCounter += 1;
    return commentIdCounter;
  }

  newLabelId(): number {
    labelIdCounter += 1;
    return labelIdCounter;
  }
}

export const store = new Store();

// ------------------------------------------------------------------ repo git helpers

export function repoLookup(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

/** Store an object in the repo and return its id. */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The oid a branch name or full ref points at; HEAD resolves through the default branch. */
export function refOid(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref);
}

/** The tree oid at the tip of a commit, or undefined when the commit does not exist. */
export function commitTreeOid(repo: Repo, commitOid: string): string | undefined {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.data).tree;
}

/** Flatten a tree (recursively) into a map from path to {mode, oid}; directories are not entries. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, TreeEntry & { path: string }> {
  const out = new Map<string, TreeEntry & { path: string }>();
  const walk = (oid: string, base: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path);
      else out.set(path, { ...entry, path });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** The blob entry at `path` inside a tree, or undefined. */
export function fileAtPath(repo: Repo, treeOid: string, path: string): TreeEntry | undefined {
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return undefined;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000' && entry.mode !== '040000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/**
 * Return a new tree oid with `path` set to `blobOid` (or removed when blobOid is null), creating
 * intermediate trees as needed. `baseTreeOid` may be undefined for an empty tree.
 */
export function updateTreePath(repo: Repo, baseTreeOid: string | undefined, path: string, blobOid: string | null): string {
  const segments = path.split('/');
  const rebuild = (treeOid: string | undefined, depth: number): string => {
    const entries: TreeEntry[] = treeOid === undefined
      ? []
      : parseTree((repo.objects.get(treeOid) as GitObject).data).map((entry) => ({ ...entry }));
    const name = segments[depth];
    const at = entries.findIndex((entry) => entry.name === name);
    if (depth === segments.length - 1) {
      if (blobOid === null) {
        if (at >= 0) entries.splice(at, 1);
      } else {
        const leaf: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (at >= 0) entries[at] = leaf;
        else entries.push(leaf);
      }
    } else {
      const childOid = at >= 0 ? entries[at].oid : undefined;
      const newChild = rebuild(childOid, depth + 1);
      const isEmpty = parseTree((repo.objects.get(newChild) as GitObject).data).length === 0;
      if (isEmpty) {
        if (at >= 0) entries.splice(at, 1);
      } else {
        const dir: TreeEntry = { mode: '40000', name, oid: newChild };
        if (at >= 0) entries[at] = dir;
        else entries.push(dir);
      }
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return rebuild(baseTreeOid, 0);
}

/** Create a commit on top of `parentOid` (or a root commit) and return its oid. */
export function createCommit(
  repo: Repo,
  input: { tree: string; parents: readonly string[]; message: string; author?: UserInfo; epochSec?: number },
): string {
  const author = input.author ?? VIEWER;
  const epoch = input.epochSec ?? nowEpochSec();
  const ident = identLine(author.name, author.email, epoch);
  const data = buildCommit({ tree: input.tree, parents: input.parents, author: ident, committer: ident, message: input.message });
  return putObject(repo, 'commit', data);
}

/** Commit a single file change onto a branch, moving the branch. Returns the new commit oid. */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  blobOid: string | null,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const parentTree = parent === undefined ? undefined : commitTreeOid(repo, parent);
  const tree = updateTreePath(repo, parentTree, path, blobOid);
  const commit = createCommit(repo, { tree, parents: parent === undefined ? [] : [parent], message });
  repo.refs.set(ref, commit);
  repo.updatedAt = nowIso();
  return commit;
}

// ------------------------------------------------------------------ diffs and merges

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function lineCounts(before: Buffer | undefined, after: Buffer | undefined): { additions: number; deletions: number } {
  const a = before === undefined ? [] : before.toString('utf8').split('\n');
  const b = after === undefined ? [] : after.toString('utf8').split('\n');
  // A trailing newline produces a final empty element that is not a line.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  // Longest-common-subsequence length over lines (files here are small).
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file-level diff between two trees (either may be undefined for an empty tree). */
export function diffTrees(repo: Repo, beforeTree: string | undefined, afterTree: string | undefined): FileChange[] {
  const before = beforeTree === undefined ? new Map() : flattenTree(repo, beforeTree);
  const after = afterTree === undefined ? new Map() : flattenTree(repo, afterTree);
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    const oldBlob = oldEntry === undefined ? undefined : repo.objects.get(oldEntry.oid)?.data;
    const newBlob = newEntry === undefined ? undefined : repo.objects.get(newEntry.oid)?.data;
    const { additions, deletions } = lineCounts(oldBlob, newBlob);
    changes.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return changes;
}

export interface MergeOutcome {
  readonly ok: boolean;
  readonly tree?: string;
  readonly conflictPath?: string;
}

/**
 * A file-level three-way merge of two trees against their common ancestor's tree. A path
 * conflicts when both sides changed it to different contents (or one side deleted what the other
 * changed). On success the merged tree is created in the repo and returned.
 */
export function mergeTrees(
  repo: Repo,
  baseTree: string | undefined,
  oursTree: string | undefined,
  theirsTree: string | undefined,
): MergeOutcome {
  const base = baseTree === undefined ? new Map() : flattenTree(repo, baseTree);
  const ours = oursTree === undefined ? new Map() : flattenTree(repo, oursTree);
  const theirs = theirsTree === undefined ? new Map() : flattenTree(repo, theirsTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  let mergedTree: string | undefined;
  for (const path of [...paths].sort()) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    let chosen: string | null;
    if (o === t) chosen = o ?? null;
    else if (b === o) chosen = t ?? null;
    else if (b === t) chosen = o ?? null;
    else return { ok: false, conflictPath: path };
    mergedTree = updateTreePath(repo, mergedTree, path, chosen);
  }
  if (mergedTree === undefined) mergedTree = putObject(repo, 'tree', buildTree([]));
  return { ok: true, tree: mergedTree };
}
