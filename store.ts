// store.ts — the forge's in-memory store and domain operations.
// One process lifetime holds everything: git objects, refs, repositories, issues,
// comments, labels and pull requests. All timestamps derive from a deterministic
// sequence counter (never a wall clock), so two runs of the same request stream
// produce identical bytes.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './gitcore.ts';

// ---------------------------------------------------------------- the viewer
// The suite's scenario (the kit's wire contract) derives its users from one fixed
// seed with the PRNG below; the token's user is the scenario viewer, so the forge
// derives the same login the same way instead of guessing it.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The scenario's first user: the login every token in a trial names. */
export function deriveViewer(): Viewer {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let viewer: Viewer | null = null;
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    if (i === 0) viewer = { id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
  }
  return viewer!;
}

// ---------------------------------------------------------------- types

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  /** bumped whenever refs move; invalidates cached packs. */
  version: number;
  packCache: Map<string, Buffer>;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headShaAtCreate: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  seq: number;
}

const EPOCH_SEC = 1_735_689_600; // the scenario's day one: 2025-01-01T00:00:00Z

export function isoOf(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly viewer: Viewer;
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  seq = 0;

  constructor() {
    this.viewer = deriveViewer();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // ---- objects ----

  putObject(type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // ---- repositories ----

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): Repo | null {
    const key = this.repoKey(this.viewer.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewer.login,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      version: 0,
      packCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login).sort((a, b) => a.id - b.id);
  }

  touchRepo(repo: Repo): void {
    repo.version += 1;
    repo.packCache.clear();
  }

  // ---- refs ----

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** All refs, sorted by name, with peeled targets for annotated tags. */
  listRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
    const out: Array<{ name: string; oid: string; peeled?: string }> = [];
    for (const name of [...repo.refs.keys()].sort()) {
      const oid = repo.refs.get(name)!;
      const entry: { name: string; oid: string; peeled?: string } = { name, oid };
      const object = this.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit((o) => this.objects.get(o), oid);
        if (peeled) entry.peeled = peeled;
      }
      out.push(entry);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` through commit parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const current = queue.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** Ancestor set of a commit with BFS generation distances (for merge-base). */
  ancestorDistances(tip: string): Map<string, number> {
    const distances = new Map<string, number>();
    let frontier = [tip];
    let depth = 0;
    while (frontier.length) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (distances.has(oid)) continue;
        distances.set(oid, depth);
        const object = this.objects.get(oid);
        if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
      depth += 1;
    }
    return distances;
  }

  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = this.ancestorDistances(a);
    // BFS from b; the first commit also ancestral to a, at the smallest combined distance, wins.
    let best: string | null = null;
    let bestScore = Infinity;
    const seen = new Set<string>();
    let frontier = [b];
    let depth = 0;
    while (frontier.length) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const da = fromA.get(oid);
        if (da !== undefined && da + depth < bestScore) {
          best = oid;
          bestScore = da + depth;
        }
        const object = this.objects.get(oid);
        if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
      depth += 1;
      if (best !== null && depth > bestScore) break;
    }
    return best;
  }

  // ---- trees as flat path maps ----

  /** Flatten a tree object into path -> {oid, mode}; empty map for a missing tree. */
  flattenTree(treeOid: string | undefined): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (!treeOid) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) nested tree objects from a flat path map; returns the root tree oid. */
  buildTreeFromMap(files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
        node = node.dirs.get(segments[i])!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  treeOfCommit(commitOid: string): string | undefined {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  filesAtCommit(commitOid: string): Map<string, { oid: string; mode: string }> {
    return this.flattenTree(this.treeOfCommit(commitOid));
  }

  blobText(oid: string): string | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return null;
    return object.data.toString('utf8');
  }

  // ---- commits made by the forge itself (contents API, merges) ----

  identity(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  /** Commit `files` on `branch`, creating the branch (root commit) when it does not exist yet. */
  commitFiles(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const tree = this.buildTreeFromMap(files);
    const seq = this.nextSeq();
    const data = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: this.identity(),
      timestamp: EPOCH_SEC + seq,
    });
    const oid = this.putObject('commit', data);
    repo.refs.set(ref, oid);
    this.touchRepo(repo);
    return oid;
  }

  // ---- issues / comments / pulls ----

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      seq: this.nextSeq(),
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, seq: this.nextSeq() };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      head: input.head,
      base: input.base,
      headShaAtCreate: this.refTip(repo, input.head) ?? '',
      merged: false,
      mergeCommitSha: null,
      mergedSeq: null,
      seq: this.nextSeq(),
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  openPullFor(repo: Repo, head: string, base: string): Pull | undefined {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) return pull;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- pull diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0) || 1;
}

/** The changed paths between two flat file maps, with line-change counts. */
export function diffFiles(
  store: Store,
  before: Map<string, { oid: string; mode: string }>,
  after: Map<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && !newEntry) {
      changes.push({ path, status: 'removed', additions: 0, deletions: lineCount(store.blobText(oldEntry.oid) ?? '') });
    } else if (!oldEntry && newEntry) {
      changes.push({ path, status: 'added', additions: lineCount(store.blobText(newEntry.oid) ?? ''), deletions: 0 });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      changes.push({
        path,
        status: 'modified',
        additions: lineCount(store.blobText(newEntry.oid) ?? ''),
        deletions: lineCount(store.blobText(oldEntry.oid) ?? ''),
      });
    }
  }
  return changes;
}

/** A pull request's changed files: merge-base tree versus head tree. */
export function pullFiles(store: Store, repo: Repo, pull: Pull): FileChange[] {
  const headTip = store.refTip(repo, pull.head);
  const baseTip = store.refTip(repo, pull.base);
  if (!headTip || !baseTip) return [];
  const base = store.mergeBase(headTip, baseTip) ?? baseTip;
  return diffFiles(store, store.filesAtCommit(base), store.filesAtCommit(headTip));
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'missing' | 'already' };

/**
 * Three-way tree merge of head into base. Returns the merged flat map, or null on a
 * content conflict (both sides changed the same path differently since the merge-base).
 */
export function mergedFiles(
  store: Store,
  repo: Repo,
  pull: Pull,
): Map<string, { oid: string; mode: string }> | null {
  const headTip = store.refTip(repo, pull.head);
  const baseTip = store.refTip(repo, pull.base);
  if (!headTip || !baseTip) return null;
  const base = store.mergeBase(headTip, baseTip);
  if (!base) return null;
  const ancestor = store.filesAtCommit(base);
  const ours = store.filesAtCommit(baseTip);
  const theirs = store.filesAtCommit(headTip);
  const result = new Map(ours);
  const paths = new Set([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (t === a) continue; // head did not touch it: keep ours
    if (o === a) {
      // only head changed it
      if (t === undefined) result.delete(path);
      else result.set(path, theirs.get(path)!);
      continue;
    }
    if (o === t) continue; // both made the same change
    return null; // both changed it differently
  }
  return result;
}

export function pullMergeable(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  return mergedFiles(store, repo, pull) !== null ? 'MERGEABLE' : 'CONFLICTING';
}

/** Squash-merge a pull request onto its base branch: one new commit with the merged tree. */
export function mergePull(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.merged) return { ok: false, reason: 'already' };
  if (pull.state !== 'open') return { ok: false, reason: 'already' };
  const headTip = store.refTip(repo, pull.head);
  const baseTip = store.refTip(repo, pull.base);
  if (!headTip || !baseTip) return { ok: false, reason: 'missing' };
  const files = mergedFiles(store, repo, pull);
  if (files === null) return { ok: false, reason: 'conflict' };
  const tree = store.buildTreeFromMap(files);
  const seq = store.nextSeq();
  const message = pull.body ? `${pull.title}\n\n${pull.body}\n` : `${pull.title}\n`;
  const data = buildCommit({
    tree,
    parents: [baseTip],
    message,
    author: store.identity(),
    timestamp: EPOCH_SEC + seq,
  });
  const sha = store.putObject('commit', data);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  store.touchRepo(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedSeq = seq;
  return { ok: true, sha };
}
