// app.ts — the forge's HTTP surface: git smart HTTP (upload-pack v2 + v0,
// receive-pack v0), the REST v3 API, GraphQL v4 and the MCP endpoint, all served
// from the one in-memory store in store.ts. main.ts owns the lifecycle; this file
// is the server. Node standard library only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktStream,
  decodePkts,
  encodePkt,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
} from './gitcore.ts';
import {
  Store,
  diffFiles,
  isoOf,
  mergePull,
  mergedFiles,
  pullFiles,
  pullMergeable,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VERSION = '1.0.0';
const SERVER_NAME = 'github-core-forge';

// ---------------------------------------------------------------- http plumbing

interface Ctx {
  store: Store;
  token: string;
  requestId: number;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(ctx: Ctx, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${++ctx.requestId}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(ctx: Ctx, res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `FORGE-${++ctx.requestId}`,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function errJson(ctx: Ctx, res: ServerResponse, status: number, message: string): void {
  sendJson(ctx, res, status, { message });
}

/** The bearer token the suite presents; anything else is unauthenticated. */
function authed(ctx: Ctx, req: IncomingMessage): boolean {
  if (!ctx.token) return false;
  return req.headers.authorization === `Bearer ${ctx.token}`;
}

function parseJsonBody(raw: Buffer): { ok: true; value: any } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------- git: fetch planning

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function parseTreeSafe(store: Store, oid: string): Array<{ mode: string; name: string; oid: string }> {
  const object = store.objects.get(oid);
  if (!object || object.type !== 'tree') return [];
  try {
    return parseTree(object.data);
  } catch {
    return [];
  }
}

/**
 * Plan a fetch: the objects to pack and the shallow boundary to report.
 * `haves` exclude their closure, except that ancestors of a shallow-listed commit
 * are not held (the client holds the boundary commit but not its parents).
 * `deepen` is a total depth when the client holds nothing shallow, and an extension
 * of the current boundary when it lists shallow commits.
 */
function planFetch(
  store: Store,
  input: { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null },
): FetchPlan {
  const shallowSet = new Set(input.shallow.filter(isOid));
  // What the client already holds.
  const held = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of input.haves) if (isOid(have) && store.objects.has(have)) queue.push(have);
    while (queue.length) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      held.add(oid);
      const object = store.objects.get(oid)!;
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) queue.push(...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTreeSafe(store, oid)) queue.push(entry.oid);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
  }

  // Resolve wants to traversal roots (tag objects are sent, then peeled to commits).
  const extra = new Set<string>();
  const roots: string[] = [];
  for (const want of input.wants) {
    if (!isOid(want)) continue;
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = store.objects.get(current);
      if (!object) break;
      if (object.type === 'commit') {
        roots.push(current);
        break;
      }
      extra.add(current);
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      break;
    }
  }

  // Depth limit.
  let limit = Infinity;
  if (input.deepen !== null && Number.isFinite(input.deepen)) {
    if (shallowSet.size > 0) {
      let distance = Infinity;
      const seen = new Map<string, number>();
      let frontier = [...new Set(roots)];
      let depth = 0;
      while (frontier.length && distance === Infinity) {
        const next: string[] = [];
        for (const oid of frontier) {
          if (seen.has(oid)) continue;
          seen.set(oid, depth);
          if (shallowSet.has(oid)) {
            distance = depth;
            break;
          }
          const object = store.objects.get(oid);
          if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
        }
        frontier = next;
        depth += 1;
      }
      limit = (distance === Infinity ? 0 : distance) + input.deepen;
    } else {
      limit = input.deepen;
    }
  }

  // BFS generations from the roots.
  const generation = new Map<string, number>();
  {
    let frontier = [...new Set(roots)];
    let depth = 0;
    while (frontier.length && depth < limit) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (generation.has(oid)) continue;
        generation.set(oid, depth);
        const object = store.objects.get(oid);
        if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
      depth += 1;
    }
  }

  const send = new Set<string>();
  for (const oid of extra) if (!held.has(oid)) send.add(oid);
  for (const oid of generation.keys()) {
    if (!held.has(oid)) send.add(oid);
    const object = store.objects.get(oid);
    if (object && object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      const queue = [tree];
      const seenTrees = new Set<string>();
      while (queue.length) {
        const current = queue.pop()!;
        if (seenTrees.has(current)) continue;
        seenTrees.add(current);
        if (!held.has(current)) send.add(current);
        for (const entry of parseTreeSafe(store, current)) {
          if (entry.mode === '40000') queue.push(entry.oid);
          else if (!held.has(entry.oid)) send.add(entry.oid);
        }
      }
    }
  }
  for (const want of input.wants) {
    const object = isOid(want) ? store.objects.get(want) : undefined;
    if (object && object.type !== 'commit' && object.type !== 'tag' && !held.has(want)) {
      send.add(want);
      if (object.type === 'tree') {
        const queue = [want];
        while (queue.length) {
          const current = queue.pop()!;
          for (const entry of parseTreeSafe(store, current)) {
            if (!held.has(entry.oid)) send.add(entry.oid);
            if (entry.mode === '40000') queue.push(entry.oid);
          }
        }
      }
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (limit !== Infinity) {
    for (const [oid, gen] of generation) {
      const object = store.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (!parents.length) continue;
      const parentHeld = parents.some((parent) => held.has(parent));
      const parentIncluded = parents.some((parent) => generation.has(parent));
      if (gen === limit - 1 && !parentHeld && !parentIncluded) shallow.push(oid);
    }
    for (const oid of shallowSet) {
      const gen = generation.get(oid);
      if (gen !== undefined && gen < limit - 1) unshallow.push(oid);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = store.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

function packForPlan(store: Store, repo: Repo, plan: FetchPlan, cacheKey: string): Buffer {
  const cached = repo.packCache.get(cacheKey);
  if (cached) return cached;
  const pack = writePack(plan.objects);
  if (repo.packCache.size < 64) repo.packCache.set(cacheKey, pack);
  return pack;
}

// ---------------------------------------------------------------- git: advertisements

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function v0Advertisement(store: Store, repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${store.headTarget(repo)}` : RECEIVE_CAPS;
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = store.listRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTarget = store.headTarget(repo);
    const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
    let first = true;
    const line = (oid: string, name: string): void => {
      if (first) {
        parts.push(encodePkt(`${oid} ${name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(encodePkt(`${oid} ${name}\n`));
      }
    };
    line(headOid, 'HEAD');
    for (const ref of refs) {
      line(ref.oid, ref.name);
      if (ref.peeled) parts.push(encodePkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => encodePkt(line)), PKT_FLUSH]);
}

// ---------------------------------------------------------------- git: ls-refs (v2)

function lsRefsResponse(store: Store, repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = store.headTarget(repo);
  const headOid = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headOid) {
      parts.push(encodePkt(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(encodePkt(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const ref of store.listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(encodePkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- git: upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  parts.push(encodePkt('acknowledgments\n'));
  const acks = args.haves.filter((have) => store.objects.has(have));
  if (acks.length === 0) {
    parts.push(encodePkt('NAK\n'));
  } else {
    for (const ack of acks) parts.push(encodePkt(`ACK ${ack}\n`));
    if (args.done) parts.push(encodePkt('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.objects.length > 0) {
    const cacheKey = `v2|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.deepen}`;
    const pack = packForPlan(store, repo, plan, cacheKey);
    parts.push(encodePkt('packfile\n'));
    parts.push(sidebandPackets(pack, 1));
    parts.push(PKT_DELIM);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  const acks = args.haves.filter((have) => store.objects.has(have));
  if (acks.length === 0) parts.push(encodePkt('NAK\n'));
  else for (const ack of acks) parts.push(encodePkt(`ACK ${ack}\n`));
  if (plan.objects.length > 0) {
    const cacheKey = `v0|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.deepen}`;
    const pack = packForPlan(store, repo, plan, cacheKey);
    parts.push(sidebandPackets(pack, 1));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): void {
  const store = ctx.store;
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    const packets = decodePktStream(raw);
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length);
    if (command === 'ls-refs') {
      sendRaw(ctx, res, 200, lsRefsResponse(store, repo, lines), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
      for (const line of lines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
        else if (line === 'done') args.done = true;
      }
      sendRaw(ctx, res, 200, fetchResponseV2(store, repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    sendRaw(ctx, res, 400, Buffer.from('unsupported command\n'), 'text/plain');
    return;
  }
  const packets = decodePktStream(raw);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: true };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
  }
  sendRaw(ctx, res, 200, fetchResponseV0(store, repo, args), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- git: receive-pack

function handleReceivePack(ctx: Ctx, res: ServerResponse, repo: Repo, raw: Buffer): void {
  const store = ctx.store;
  const { packets, consumed } = decodePkts(raw);
  const packBytes = raw.subarray(consumed);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capabilities = '';
  let firstLine = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (firstLine) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      firstLine = false;
    }
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  const wantsReport = capabilities.includes('report-status');
  const useSideband = capabilities.includes('side-band-64k');

  let unpackLine = 'unpack ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => store.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!store.objects.has(oid)) store.objects.set(oid, object);
      }
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ') : 'error'}`;
    }
  }

  const reportLines: string[] = [unpackLine];
  if (unpackLine === 'unpack ok') {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let failure: string | null = null;
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) failure = 'reference does not exist';
        else repo.refs.delete(command.ref);
      } else {
        const object = store.objects.get(command.newOid);
        if (!object) failure = 'unknown object';
        else if (command.oldOid !== current) failure = 'stale info';
        else if (command.oldOid !== ZERO_OID && command.ref.startsWith('refs/heads/') && !store.isAncestor(command.oldOid, command.newOid)) {
          failure = 'non-fast-forward';
        }
        if (!failure) repo.refs.set(command.ref, command.newOid);
      }
      reportLines.push(failure ? `ng ${command.ref} ${failure}` : `ok ${command.ref}`);
    }
    if (commands.length) store.touchRepo(repo);
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error`);
  }

  if (!wantsReport) {
    sendRaw(ctx, res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const report = Buffer.concat([...reportLines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]);
  const body = useSideband ? Buffer.concat([sidebandPackets(report, 1), PKT_FLUSH]) : report;
  sendRaw(ctx, res, 200, body, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- REST: shapes

function repoJson(store: Store, repo: Repo): any {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: isoOf(repo.id),
    updated_at: isoOf(repo.id),
    pushed_at: isoOf(repo.id),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `/${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(repo: Repo, name: string): any {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: null, default: false };
}

function issueJson(store: Store, repo: Repo, issue: Issue): any {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    author: { login: store.viewer.login, id: store.viewer.id },
    comments: issue.comments.length,
    locked: false,
    created_at: isoOf(issue.seq),
    updated_at: isoOf(issue.seq),
    closed_at: issue.state === 'closed' ? isoOf(issue.seq) : null,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    pull_request: undefined,
  };
}

function commentJson(store: Store, comment: { id: number; body: string; seq: number }): any {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: isoOf(comment.seq),
    updated_at: isoOf(comment.seq),
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): any {
  const headSha = store.refTip(repo, pull.head) ?? pull.headShaAtCreate;
  const baseSha = store.refTip(repo, pull.base) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    head: {
      ref: pull.head,
      sha: headSha,
      label: `${repo.owner}:${pull.head}`,
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.base,
      sha: baseSha,
      label: `${repo.owner}:${pull.base}`,
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    merged: pull.merged,
    merged_at: pull.merged && pull.mergedSeq !== null ? isoOf(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: isoOf(pull.seq),
    updated_at: isoOf(pull.seq),
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(store: Store, oid: string): any {
  const object = store.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const parseIdent = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident);
    if (!match) return { name: ident, email: '', date: isoOf(0) };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: parseIdent(commit.author),
      committer: parseIdent(commit.committer),
      comment_count: 0,
    },
    author: { login: store.viewer.login, id: store.viewer.id },
    committer: { login: store.viewer.login, id: store.viewer.id },
    parents: commit.parents.map((sha) => ({ sha })),
    html_url: `/${store.viewer.login}/commit/${oid}`,
  };
}

/** Commits reachable from a tip, newest first (timestamp desc, then BFS order). */
function listCommits(store: Store, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    order.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  const decorated = order.map((oid, index) => {
    const object = store.objects.get(oid)!;
    return { oid, index, ts: parseCommit(object.data).timestamp };
  });
  decorated.sort((a, b) => b.ts - a.ts || a.index - b.index);
  return decorated.map((entry) => entry.oid);
}

function pagination(url: URL): { page: number; perPage: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
  };
}

function linkHeader(req: IncomingMessage, url: URL, page: number, perPage: number, total: number): string | undefined {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return undefined;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const make = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(make(page + 1, 'next'), make(totalPages, 'last'));
  if (page > 1) parts.push(make(page - 1, 'prev'), make(1, 'first'));
  return parts.length ? parts.join(', ') : undefined;
}

// ---------------------------------------------------------------- REST: contents

function resolveRefCommit(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (!ref) return store.refTip(repo, repo.defaultBranch);
  const byBranch = store.refTip(repo, ref);
  if (byBranch) return byBranch;
  if (isOid(ref) && store.objects.get(ref)?.type === 'commit') return ref;
  const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  return byRef;
}

/** PUT or DELETE one file on a branch; returns the REST answer. */
function contentsCommit(
  ctx: Ctx,
  res: ServerResponse,
  repo: Repo,
  path: string,
  body: any,
  mode: 'put' | 'delete',
): void {
  const store = ctx.store;
  const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body?.message === 'string' && body.message !== '' ? body.message : mode === 'put' ? `Update ${path}` : `Delete ${path}`;
  const tip = store.refTip(repo, branch);
  const files = tip ? store.filesAtCommit(tip) : new Map<string, { oid: string; mode: string }>();
  const existing = files.get(path);
  if (mode === 'delete') {
    if (!existing) return errJson(ctx, res, 404, 'Not Found');
    if (typeof body?.sha === 'string' && body.sha !== existing.oid) return errJson(ctx, res, 409, 'Conflict: sha does not match');
    files.delete(path);
    const commitSha = store.commitFiles(repo, branch, files, message);
    sendJson(ctx, res, 200, { content: null, commit: { sha: commitSha, message } });
    return;
  }
  const contentBase64 = typeof body?.content === 'string' ? body.content : '';
  const data = Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64');
  if (existing) {
    if (typeof body?.sha === 'string' && body.sha !== existing.oid) {
      return errJson(ctx, res, 409, `${path} does not match ${body.sha}`);
    }
    if (typeof body?.sha !== 'string' && body?.sha === undefined && false) return errJson(ctx, res, 422, 'sha is required');
  }
  const blobOid = store.putObject('blob', data);
  files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const commitSha = store.commitFiles(repo, branch, files, message);
  const status = existing ? 200 : 201;
  sendJson(ctx, res, status, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: data.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: commitSha, message },
  });
}

// ---------------------------------------------------------------- REST: router

async function handleRest(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<void> {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((s) => s !== '').map(decodeSegment);
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (!authed(ctx, req)) return errJson(ctx, res, 401, 'Bad credentials');

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: any = undefined;
  if (needsBody && raw.length > 0) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return errJson(ctx, res, 400, 'Problems parsing JSON');
    body = parsed.value;
  } else if (needsBody) {
    body = {};
  }

  // API root and meta
  if (rest.length === 0) {
    if (method !== 'GET') return errJson(ctx, res, 404, 'Not Found');
    return sendJson(
      ctx,
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org, write:org' },
    );
  }
  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    return sendJson(ctx, res, 200, {
      verifiable_password_authentication: false,
      installed_version: `${VERSION}-forge`,
      github_services_sha: 'forge',
    });
  }
  if (rest[0] === 'rate_limit' && rest.length === 1 && method === 'GET') {
    return sendJson(ctx, res, 200, {
      rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 },
      resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } },
    });
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    return sendJson(ctx, res, 200, {
      login: store.viewer.login,
      id: store.viewer.id,
      name: store.viewer.name,
      email: store.viewer.email,
      type: 'User',
      site_admin: false,
    });
  }

  // /user/repos
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = store.viewerRepos().map((repo) => repoJson(store, repo));
      const { page, perPage } = pagination(url);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const link = linkHeader(req, url, page, perPage, all.length);
      return sendJson(ctx, res, 200, slice, link ? { link } : {});
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) return errJson(ctx, res, 422, 'Validation Failed: name is required');
      const repo = store.createRepo(name, {
        description: typeof body?.description === 'string' ? body.description : '',
        isPrivate: typeof body?.private === 'boolean' ? body.private : false,
      });
      if (!repo) return errJson(ctx, res, 422, 'Validation Failed: name already exists on this account');
      return sendJson(ctx, res, 201, repoJson(store, repo));
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  // /repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = store.getRepo(owner, name);
    if (!repo) return errJson(ctx, res, 404, 'Not Found');
    const tail = rest.slice(3);
    return handleRepoRest(ctx, req, res, url, repo, tail, method, body);
  }

  return errJson(ctx, res, 404, 'Not Found');
}

function handleRepoRest(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  tail: string[],
  method: string,
  body: any,
): void {
  const store = ctx.store;

  // the repository itself
  if (tail.length === 0) {
    if (method === 'GET') return sendJson(ctx, res, 200, repoJson(store, repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.name === 'string' && body.name !== repo.name) {
        store.repos.delete(store.repoKey(repo.owner, repo.name));
        repo.name = body.name;
        store.repos.set(store.repoKey(repo.owner, repo.name), repo);
      }
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      return sendJson(ctx, res, 200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': `FORGE-${++ctx.requestId}` });
      res.end();
      return;
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  // branches
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return sendJson(ctx, res, 200, branches);
  }
  if (tail[0] === 'branches' && tail.length >= 2) {
    const branch = tail.slice(1).join('/');
    const tip = store.refTip(repo, branch);
    if (method === 'GET' && tip) return sendJson(ctx, res, 200, { name: branch, commit: { sha: tip }, protected: false });
    return errJson(ctx, res, 404, 'Not Found');
  }

  // commits
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = url.searchParams.get('sha');
    const tip = resolveRefCommit(store, repo, ref);
    if (!tip) return sendJson(ctx, res, 200, []);
    const { page, perPage } = pagination(url);
    const all = listCommits(store, tip).map((oid) => commitJson(store, oid)).filter(Boolean);
    return sendJson(ctx, res, 200, all.slice((page - 1) * perPage, page * perPage));
  }
  if (tail[0] === 'commits' && tail.length === 2 && method === 'GET') {
    const json = commitJson(store, tail[1]);
    if (!json) return errJson(ctx, res, 404, 'Not Found');
    return sendJson(ctx, res, 200, json);
  }

  // git refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !store.objects.get(sha)) return errJson(ctx, res, 422, 'Validation Failed');
      if (repo.refs.has(ref)) return errJson(ctx, res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      store.touchRepo(repo);
      return sendJson(ctx, res, 201, { ref, object: { sha, type: store.objects.get(sha)!.type } });
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return errJson(ctx, res, 404, 'Not Found');
      return sendJson(ctx, res, 200, { ref, object: { sha, type: store.objects.get(sha)?.type ?? 'commit' } });
    }
    if (tail.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: store.objects.get(sha)?.type ?? 'commit' } }));
      return sendJson(ctx, res, 200, refs);
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  // contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'PUT') return contentsCommit(ctx, res, repo, path, body, 'put');
    if (method === 'DELETE') return contentsCommit(ctx, res, repo, path, body, 'delete');
    if (method === 'GET') {
      const ref = url.searchParams.get('ref');
      const tip = resolveRefCommit(store, repo, ref);
      if (!tip) return errJson(ctx, res, 404, 'Not Found');
      const files = store.filesAtCommit(tip);
      if (path === '') {
        return sendJson(ctx, res, 200, dirListing(store, repo, files, ''));
      }
      const file = files.get(path);
      if (file) {
        const object = store.objects.get(file.oid);
        const data = object?.data ?? Buffer.alloc(0);
        return sendJson(ctx, res, 200, {
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
          name: path.split('/').pop() ?? path,
          path,
          sha: file.oid,
          size: data.length,
        });
      }
      const prefix = `${path}/`;
      const isDir = [...files.keys()].some((candidate) => candidate.startsWith(prefix));
      if (isDir) return sendJson(ctx, res, 200, dirListing(store, repo, files, path));
      return errJson(ctx, res, 404, 'Not Found');
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  // labels
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) return errJson(ctx, res, 422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return errJson(ctx, res, 422, 'Validation Failed: already exists');
      repo.labels.set(name, { name, color: typeof body?.color === 'string' ? body.color : 'ededed' });
      return sendJson(ctx, res, 201, labelJson(repo, name));
    }
    if (method === 'GET') return sendJson(ctx, res, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    return errJson(ctx, res, 404, 'Not Found');
  }

  // issues
  if (tail[0] === 'issues') {
    return handleIssues(ctx, res, url, repo, tail.slice(1), method, body);
  }

  // pulls
  if (tail[0] === 'pulls') {
    return handlePulls(ctx, res, url, repo, tail.slice(1), method, body);
  }

  return errJson(ctx, res, 404, 'Not Found');
}

function dirListing(
  store: Store,
  repo: Repo,
  files: Map<string, { oid: string; mode: string }>,
  dir: string,
): any[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const restPath = path.slice(prefix.length);
    const slash = restPath.indexOf('/');
    if (slash < 0) {
      entries.set(restPath, { type: 'file', sha: entry.oid });
    } else {
      const name = restPath.slice(0, slash);
      if (!entries.has(name)) {
        // a directory's sha: the subtree's tree oid, recomputed from the flat map
        const sub = new Map<string, { oid: string; mode: string }>();
        for (const [candidate, candidateEntry] of files) {
          if (candidate.startsWith(`${prefix}${name}/`)) sub.set(candidate.slice(prefix.length + name.length + 1), candidateEntry);
        }
        entries.set(name, { type: 'dir', sha: store.buildTreeFromMap(sub) });
      }
    }
  }
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.sha,
      size: entry.type === 'file' ? (store.objects.get(entry.sha)?.data.length ?? 0) : 0,
    }));
}

function labelNamesOf(body: any): string[] | null {
  if (!Array.isArray(body?.labels)) return null;
  const names: string[] = [];
  for (const label of body.labels) {
    if (typeof label === 'string') names.push(label);
    else if (label && typeof label.name === 'string') names.push(label.name);
  }
  return names;
}

function handleIssues(ctx: Ctx, res: ServerResponse, url: URL, repo: Repo, tail: string[], method: string, body: any): void {
  const store = ctx.store;
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (!title) return errJson(ctx, res, 422, 'Validation Failed: title is required');
      const labels = labelNamesOf(body) ?? [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return errJson(ctx, res, 422, `Validation Failed: label ${name} does not exist`);
      }
      const issue = store.createIssue(repo, {
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        labels,
      });
      return sendJson(ctx, res, 201, issueJson(store, repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
      const { page, perPage } = pagination(url);
      return sendJson(ctx, res, 200, list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(store, repo, issue)));
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (tail.length === 1) {
    if (!issue) return errJson(ctx, res, 404, 'Not Found');
    if (method === 'GET') return sendJson(ctx, res, 200, issueJson(store, repo, issue));
    if (method === 'PATCH') {
      if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      const labels = labelNamesOf(body);
      if (labels) {
        for (const name of labels) if (!repo.labels.has(name)) return errJson(ctx, res, 422, `Validation Failed: label ${name} does not exist`);
        issue.labels = labels;
      }
      return sendJson(ctx, res, 200, issueJson(store, repo, issue));
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return errJson(ctx, res, 404, 'Not Found');
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      if (!text) return errJson(ctx, res, 422, 'Validation Failed: body is required');
      const comment = store.addComment(repo, issue, text);
      return sendJson(ctx, res, 201, commentJson(store, comment));
    }
    if (method === 'GET') {
      return sendJson(ctx, res, 200, issue.comments.map((comment) => commentJson(store, comment)));
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'labels' && method === 'POST') {
    if (!issue) return errJson(ctx, res, 404, 'Not Found');
    const labels = labelNamesOf(body) ?? (typeof body?.name === 'string' ? [body.name] : []);
    for (const name of labels) if (!repo.labels.has(name)) return errJson(ctx, res, 422, `Validation Failed: label ${name} does not exist`);
    for (const name of labels) if (!issue.labels.includes(name)) issue.labels.push(name);
    return sendJson(ctx, res, 200, issue.labels.map((name) => labelJson(repo, name)));
  }

  return errJson(ctx, res, 404, 'Not Found');
}

function normalizeBranchRef(value: unknown): string {
  if (typeof value !== 'string') return '';
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function createPullChecked(ctx: Ctx, res: ServerResponse, repo: Repo, input: any): Pull | null {
  const store = ctx.store;
  const title = typeof input?.title === 'string' ? input.title : '';
  const head = normalizeBranchRef(input?.head ?? input?.headRefName);
  const base = normalizeBranchRef(input?.base ?? input?.baseRefName) || repo.defaultBranch;
  if (!title || !head) {
    errJson(ctx, res, 422, 'Validation Failed: title and head are required');
    return null;
  }
  if (!store.refTip(repo, head)) {
    errJson(ctx, res, 422, `Validation Failed: head ${head} does not exist`);
    return null;
  }
  if (!store.refTip(repo, base)) {
    errJson(ctx, res, 422, `Validation Failed: base ${base} does not exist`);
    return null;
  }
  const existing = store.openPullFor(repo, head, base);
  if (existing) {
    errJson(ctx, res, 422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
    return null;
  }
  return store.createPull(repo, { title, body: typeof input?.body === 'string' ? input.body : '', head, base });
}

function handlePulls(ctx: Ctx, res: ServerResponse, url: URL, repo: Repo, tail: string[], method: string, body: any): void {
  const store = ctx.store;
  if (tail.length === 0) {
    if (method === 'POST') {
      const pull = createPullChecked(ctx, res, repo, body);
      if (!pull) return;
      return sendJson(ctx, res, 201, pullJson(store, repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.seq - a.seq || b.number - a.number);
      const { page, perPage } = pagination(url);
      return sendJson(ctx, res, 200, list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(store, repo, pull)));
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (tail.length === 1) {
    if (!pull) return errJson(ctx, res, 404, 'Not Found');
    if (method === 'GET') return sendJson(ctx, res, 200, pullJson(store, repo, pull));
    if (method === 'PATCH') {
      if (body?.state === 'open' || body?.state === 'closed') pull.state = body.state;
      if (typeof body?.title === 'string') pull.title = body.title;
      if (typeof body?.body === 'string') pull.body = body.body;
      return sendJson(ctx, res, 200, pullJson(store, repo, pull));
    }
    return errJson(ctx, res, 404, 'Not Found');
  }

  if (!pull) return errJson(ctx, res, 404, 'Not Found');

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const { page, perPage } = pagination(url);
    const files = pullFiles(store, repo, pull).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: store.filesAtCommit(store.refTip(repo, pull.head) ?? '').get(change.path)?.oid ?? '',
    }));
    return sendJson(ctx, res, 200, files.slice((page - 1) * perPage, page * perPage));
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const outcome = mergePull(store, repo, pull);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') return errJson(ctx, res, 405, 'Pull Request is not mergeable: conflict');
      return errJson(ctx, res, 405, 'Pull Request is not mergeable');
    }
    return sendJson(ctx, res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return errJson(ctx, res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL: ids

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || !parts[0]) return null;
    return { type: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}
function commentGlobalId(comment: { id: number }): string {
  return globalId('Comment', String(comment.id));
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ---------------------------------------------------------------- GraphQL: parser
// A focused parser for the documents gh and github-mcp-server send: operations with
// variables, aliases, arguments with nested literals, inline fragments and spreads.

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: GqlValue }>;
  selection: GqlSelection[] | null;
}
interface GqlInline {
  kind: 'inline';
  typeCondition: string | null;
  selection: GqlSelection[];
}
interface GqlSpread {
  kind: 'spread';
  name: string;
}
type GqlSelection = GqlField | GqlInline | GqlSpread;

interface GqlOperation {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: GqlSelection[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function tokenizeGql(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:@=$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: Token[];
  private pos = 0;
  constructor(source: string) {
    this.tokens = tokenizeGql(source);
  }
  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos++];
    if (!token) throw new Error('unexpected end of document');
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const word = this.next();
      if (word.kind !== 'name') throw new Error(`unexpected token ${word.value}`);
      if (word.value === 'query' || word.value === 'mutation' || word.value === 'subscription') {
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipBalanced('(', ')');
        // directives before the selection set
        while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
          this.next();
          this.next();
          if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipBalanced('(', ')');
        }
        operations.push({ operation: word.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (word.value === 'fragment') {
        const fragName = this.next().value;
        this.next(); // on
        this.next(); // type name
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected definition ${word.value}`);
      }
    }
    return { operations, fragments };
  }
  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }
  private parseSelection(): GqlSelection {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const name = this.next();
      if (name.kind === 'name' && name.value === 'on') {
        const typeName = this.next().value;
        return { kind: 'inline', typeCondition: typeName, selection: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: name.value };
    }
    let nameToken = this.next();
    if (nameToken.kind !== 'name') throw new Error(`expected field name, got ${nameToken.value}`);
    let alias: string | null = null;
    let fieldName = nameToken.value;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = fieldName;
      fieldName = this.next().value;
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      for (;;) {
        const peeked = this.peek();
        if (peeked?.kind === 'punct' && peeked.value === ')') {
          this.next();
          break;
        }
        const argName = this.next().value;
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipBalanced('(', ')');
    }
    let selection: GqlSelection[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name: fieldName, alias, args, selection };
  }
  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.next().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked?.kind === 'punct' && peeked.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked?.kind === 'punct' && peeked.value === '}') {
          this.next();
          break;
        }
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function evalGqlValue(value: GqlValue, variables: Record<string, any>): any {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'number':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalGqlValue(item, variables));
    case 'object': {
      const out: Record<string, any> = {};
      for (const field of value.fields) out[field.name] = evalGqlValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- GraphQL: execution

const UNKNOWN_FIELD = Symbol('unknown-field');

interface GqlSource {
  type: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  comment?: { id: number; body: string; seq: number };
  login?: string;
  refName?: string;
  items?: any[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  typeName?: string;
  fieldName?: string;
  enumName?: string;
  payload?: any;
  file?: { path: string; additions: number; deletions: number };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'closed', 'locked'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
    'author', 'repository', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'url', 'closed', 'additions', 'deletions', 'changedFiles',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequests', 'pullRequest', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt', 'nameWithOwner',
  ],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE'];

interface GqlExec {
  store: Store;
  variables: Record<string, any>;
  fragments: Map<string, GqlSelection[]>;
  errors: Array<{ message: string }>;
}

function connectionSource(kind: string, items: GqlSource[], pageInfo: { hasNextPage: boolean; endCursor: string | null }): GqlSource {
  return { type: kind, items, pageInfo };
}

function paginateBySeq<T extends { seq: number }>(
  items: T[],
  args: Record<string, any>,
  descending: boolean,
): { page: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 30;
  let rest = items;
  if (typeof args.after === 'string' && args.after) {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^seq:(\d+)$/.exec(decoded);
      if (match) {
        const cursorSeq = Number(match[1]);
        rest = items.filter((item) => (descending ? item.seq < cursorSeq : item.seq > cursorSeq));
      }
    } catch {
      // an opaque cursor we did not mint: start from the beginning
    }
  }
  const page = rest.slice(0, first);
  const last = page[page.length - 1];
  return {
    page,
    pageInfo: {
      hasNextPage: rest.length > first,
      endCursor: last ? Buffer.from(`seq:${last.seq}`, 'utf8').toString('base64') : null,
    },
  };
}

function gqlField(exec: GqlExec, source: GqlSource, field: string, args: Record<string, any>): any {
  const store = exec.store;
  switch (source.type) {
    case 'Query':
    case 'Mutation': {
      if (field === 'viewer') return { type: 'User', login: store.viewer.login } as GqlSource;
      if (field === 'repository') {
        const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? store.getRepo(args.owner, args.name) : undefined;
        return repo ? ({ type: 'Repository', repo } as GqlSource) : null;
      }
      if (field === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          return repo ? ({ type: 'Repository', repo } as GqlSource) : null;
        }
        if (decoded.type === 'Issue') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          const issue = repo?.issues.get(Number(decoded.parts[1]));
          return repo && issue ? ({ type: 'Issue', repo, issue } as GqlSource) : null;
        }
        if (decoded.type === 'PullRequest') {
          const repo = findRepoById(store, Number(decoded.parts[0]));
          const pull = repo?.pulls.get(Number(decoded.parts[1]));
          return repo && pull ? ({ type: 'PullRequest', repo, pull } as GqlSource) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        if (TYPE_FIELDS[name] || name === 'SearchType') return { type: '__Type', typeName: name } as GqlSource;
        return null;
      }
      if (field === 'createIssue') {
        const input = args.input ?? {};
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded?.type === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
        if (!repo || typeof input.title !== 'string') {
          exec.errors.push({ message: 'createIssue: repository not found or title missing' });
          return null;
        }
        const issue = store.createIssue(repo, { title: input.title, body: typeof input.body === 'string' ? input.body : '' });
        return { type: 'CreateIssuePayload', payload: { type: 'Issue', repo, issue } } as GqlSource;
      }
      if (field === 'closeIssue') {
        const input = args.input ?? {};
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        const repo = decoded?.type === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
        const issue = repo?.issues.get(Number(decoded?.parts[1]));
        if (!repo || !issue) {
          exec.errors.push({ message: 'closeIssue: issue not found' });
          return null;
        }
        issue.state = 'closed';
        return { type: 'CloseIssuePayload', payload: { type: 'Issue', repo, issue } } as GqlSource;
      }
      if (field === 'createPullRequest') {
        const input = args.input ?? {};
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded?.type === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo?.defaultBranch ?? '';
        if (!repo || !head || !store.refTip(repo, head)) {
          exec.errors.push({ message: 'createPullRequest: repository or head branch not found' });
          return null;
        }
        const existing = store.openPullFor(repo, head, base);
        const pull = existing ?? store.createPull(repo, { title: typeof input.title === 'string' ? input.title : '', body: typeof input.body === 'string' ? input.body : '', head, base });
        return { type: 'CreatePullRequestPayload', payload: { type: 'PullRequest', repo, pull } } as GqlSource;
      }
      if (field === 'mergePullRequest') {
        const input = args.input ?? {};
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        const repo = decoded?.type === 'PullRequest' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
        const pull = repo?.pulls.get(Number(decoded?.parts[1]));
        if (!repo || !pull) {
          exec.errors.push({ message: 'mergePullRequest: pull request not found' });
          return null;
        }
        const outcome = mergePull(store, repo, pull);
        if (!outcome.ok && outcome.reason === 'conflict') {
          exec.errors.push({ message: 'mergePullRequest: pull request has conflicts' });
          return null;
        }
        return { type: 'MergePullRequestPayload', payload: { type: 'PullRequest', repo, pull } } as GqlSource;
      }
      if (field === 'addComment') {
        const input = args.input ?? {};
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        const repo = decoded?.type === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
        const issue = repo?.issues.get(Number(decoded?.parts[1]));
        if (!repo || !issue || typeof input.body !== 'string') {
          exec.errors.push({ message: 'addComment: subject not found' });
          return null;
        }
        const comment = store.addComment(repo, issue, input.body);
        return { type: 'AddCommentPayload', payload: { type: 'Comment', repo, issue, comment } } as GqlSource;
      }
      return UNKNOWN_FIELD;
    }
    case 'User': {
      if (field === 'login') return source.login ?? store.viewer.login;
      if (field === 'id') return globalId('User', String(store.viewer.id));
      if (field === 'name') return store.viewer.name;
      if (field === 'databaseId') return store.viewer.id;
      return UNKNOWN_FIELD;
    }
    case 'Repository': {
      const repo = source.repo!;
      switch (field) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { type: 'User', login: repo.owner } as GqlSource;
        case 'defaultBranchRef': {
          const tip = store.refTip(repo, repo.defaultBranch);
          return tip ? ({ type: 'Ref', refName: repo.defaultBranch, repo } as GqlSource) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'createdAt':
        case 'updatedAt':
          return isoOf(repo.id);
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? ({ type: 'Issue', repo, issue } as GqlSource) : null;
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          if (Array.isArray(args.states) && args.states.length) {
            const wanted = new Set(args.states.map((state: any) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const descending = args.orderBy?.direction === 'DESC';
          list.sort((a, b) => (descending ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
          const { page, pageInfo } = paginateBySeq(list, args, descending);
          return connectionSource('IssueConnection', page.map((issue) => ({ type: 'Issue', repo, issue }) as GqlSource), pageInfo);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? ({ type: 'PullRequest', repo, pull } as GqlSource) : null;
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          if (Array.isArray(args.states) && args.states.length) {
            const wanted = new Set(args.states.map((state: any) => String(state).toUpperCase()));
            list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          list.sort((a, b) => b.seq - a.seq || b.number - a.number);
          const { page, pageInfo } = paginateBySeq(list, args, true);
          return connectionSource('PullRequestConnection', page.map((pull) => ({ type: 'PullRequest', repo, pull }) as GqlSource), pageInfo);
        }
        default:
          return UNKNOWN_FIELD;
      }
    }
    case 'Ref': {
      if (field === 'name') return source.refName ?? '';
      if (field === 'prefix') return `refs/heads/${source.refName ?? ''}`;
      if (field === 'target') {
        const tip = source.repo ? store.refTip(source.repo, source.refName ?? '') : undefined;
        return tip ? { type: 'GitObject', payload: tip } : null;
      }
      return UNKNOWN_FIELD;
    }
    case 'GitObject': {
      if (field === 'oid' || field === 'id') return source.payload as string;
      return UNKNOWN_FIELD;
    }
    case 'Issue': {
      const issue = source.issue!;
      const repo = source.repo!;
      switch (field) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'closed':
          return issue.state === 'closed';
        case 'locked':
          return false;
        case 'createdAt':
        case 'updatedAt':
          return isoOf(issue.seq);
        case 'url':
          return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'author':
          return { type: 'User', login: store.viewer.login } as GqlSource;
        case 'repository':
          return { type: 'Repository', repo } as GqlSource;
        case 'labels':
          return connectionSource('LabelConnection', issue.labels.map((name) => ({ type: 'Label', fieldName: name }) as GqlSource), { hasNextPage: false, endCursor: null });
        case 'comments':
          return connectionSource('IssueCommentConnection', issue.comments.map((comment) => ({ type: 'Comment', repo, issue, comment }) as GqlSource), { hasNextPage: false, endCursor: null });
        default:
          return UNKNOWN_FIELD;
      }
    }
    case 'PullRequest': {
      const pull = source.pull!;
      const repo = source.repo!;
      switch (field) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'closed':
          return pull.state === 'closed';
        case 'mergeable':
          return pullMergeable(store, repo, pull);
        case 'createdAt':
        case 'updatedAt':
          return isoOf(pull.seq);
        case 'url':
          return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'author':
          return { type: 'User', login: store.viewer.login } as GqlSource;
        case 'repository':
          return { type: 'Repository', repo } as GqlSource;
        case 'headRef':
          return { type: 'Ref', refName: pull.head, repo } as GqlSource;
        case 'baseRef':
          return { type: 'Ref', refName: pull.base, repo } as GqlSource;
        case 'files': {
          const files = pullFiles(store, repo, pull).map(
            (change) => ({ type: 'PullRequestFile', file: { path: change.path, additions: change.additions, deletions: change.deletions } }) as GqlSource,
          );
          const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : files.length;
          return connectionSource('PullRequestFileConnection', files.slice(0, first), {
            hasNextPage: files.length > first,
            endCursor: null,
          });
        }
        case 'additions':
          return pullFiles(store, repo, pull).reduce((sum, change) => sum + change.additions, 0);
        case 'deletions':
          return pullFiles(store, repo, pull).reduce((sum, change) => sum + change.deletions, 0);
        case 'changedFiles':
          return pullFiles(store, repo, pull).length;
        default:
          return UNKNOWN_FIELD;
      }
    }
    case 'PullRequestFile': {
      if (field === 'path') return source.file!.path;
      if (field === 'additions') return source.file!.additions;
      if (field === 'deletions') return source.file!.deletions;
      return UNKNOWN_FIELD;
    }
    case 'Comment': {
      const comment = source.comment ?? (source.payload as any)?.comment;
      if (!comment) return UNKNOWN_FIELD;
      if (field === 'id') return commentGlobalId(comment);
      if (field === 'body') return comment.body;
      if (field === 'createdAt' || field === 'updatedAt') return isoOf(comment.seq);
      if (field === 'author') return { type: 'User', login: store.viewer.login } as GqlSource;
      return UNKNOWN_FIELD;
    }
    case 'Label': {
      if (field === 'name') return source.fieldName ?? '';
      if (field === 'id') return globalId('Label', source.fieldName ?? '');
      return UNKNOWN_FIELD;
    }
    case '__Type': {
      const name = source.typeName!;
      if (field === 'name') return name;
      if (field === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name];
        return fields ? fields.map((fieldName) => ({ type: '__Field', fieldName }) as GqlSource) : null;
      }
      if (field === 'enumValues') {
        return name === 'SearchType' ? SEARCH_TYPE_VALUES.map((enumName) => ({ type: '__EnumValue', enumName }) as GqlSource) : null;
      }
      if (field === 'possibleTypes') return null;
      if (field === 'interfaces') return [];
      if (field === 'inputFields') return null;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      return UNKNOWN_FIELD;
    }
    case '__Field': {
      if (field === 'name') return source.fieldName ?? '';
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'args') return [];
      if (field === 'type') return null;
      return UNKNOWN_FIELD;
    }
    case '__EnumValue': {
      if (field === 'name') return source.enumName ?? '';
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      return UNKNOWN_FIELD;
    }
    default:
      break;
  }

  // Connections and payloads share a small field vocabulary.
  if (source.type.endsWith('Connection')) {
    if (field === 'nodes') return source.items ?? [];
    if (field === 'edges') {
      return (source.items ?? []).map((item) => ({ type: 'Edge', payload: item }) as GqlSource);
    }
    if (field === 'pageInfo') return { type: 'PageInfo', pageInfo: source.pageInfo } as GqlSource;
    if (field === 'totalCount') return (source.items ?? []).length;
    return UNKNOWN_FIELD;
  }
  if (source.type === 'Edge') {
    if (field === 'node') return source.payload as GqlSource;
    if (field === 'cursor') return '';
    return UNKNOWN_FIELD;
  }
  if (source.type === 'PageInfo') {
    if (field === 'hasNextPage') return source.pageInfo?.hasNextPage ?? false;
    if (field === 'endCursor') return source.pageInfo?.endCursor ?? null;
    if (field === 'hasPreviousPage') return false;
    if (field === 'startCursor') return source.pageInfo?.endCursor ?? null;
    return UNKNOWN_FIELD;
  }
  if (source.type === 'CreateIssuePayload' || source.type === 'CloseIssuePayload') {
    if (field === 'issue') return source.payload as GqlSource;
    if (field === 'clientMutationId') return null;
    return UNKNOWN_FIELD;
  }
  if (source.type === 'CreatePullRequestPayload' || source.type === 'MergePullRequestPayload') {
    if (field === 'pullRequest') return source.payload as GqlSource;
    if (field === 'clientMutationId') return null;
    return UNKNOWN_FIELD;
  }
  if (source.type === 'AddCommentPayload') {
    if (field === 'commentEdge') return { type: 'CommentEdge', payload: source.payload } as GqlSource;
    if (field === 'clientMutationId') return null;
    if (field === 'subject') return source.payload as GqlSource;
    return UNKNOWN_FIELD;
  }
  if (source.type === 'CommentEdge') {
    if (field === 'node') return source.payload as GqlSource;
    if (field === 'cursor') return '';
    return UNKNOWN_FIELD;
  }
  return UNKNOWN_FIELD;
}

function resolveSelectionSet(exec: GqlExec, source: GqlSource, selections: GqlSelection[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === source.type) {
        Object.assign(out, resolveSelectionSet(exec, source, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment) Object.assign(out, resolveSelectionSet(exec, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.type;
      continue;
    }
    const args: Record<string, any> = {};
    for (const arg of selection.args) args[arg.name] = evalGqlValue(arg.value, exec.variables);
    const value = gqlField(exec, source, selection.name, args);
    if (value === UNKNOWN_FIELD) {
      exec.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${source.type}'` });
      out[key] = null;
      continue;
    }
    out[key] = resolveValue(exec, value, selection.selection);
  }
  return out;
}

function resolveValue(exec: GqlExec, value: any, selection: GqlSelection[] | null): any {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => resolveValue(exec, item, selection));
  if (typeof value === 'object' && typeof (value as GqlSource).type === 'string' && selection) {
    return resolveSelectionSet(exec, value as GqlSource, selection);
  }
  if (typeof value === 'object' && typeof (value as GqlSource).type === 'string' && !selection) {
    return null;
  }
  return value;
}

function executeGraphQL(store: Store, query: string, variables: Record<string, any>, operationName?: string): any {
  let document: { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> };
  try {
    document = new GqlParser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  let operation = document.operations[0];
  if (operationName) operation = document.operations.find((op) => op.name === operationName) ?? operation;
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const exec: GqlExec = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelectionSet(exec, { type: rootType } as GqlSource, operation.selection);
  const result: any = { data };
  if (exec.errors.length) result.errors = exec.errors;
  return result;
}

async function handleGraphQL(ctx: Ctx, req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  if (!authed(ctx, req)) return errJson(ctx, res, 401, 'Bad credentials');
  if ((req.method ?? 'GET') !== 'POST') return errJson(ctx, res, 404, 'Not Found');
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return errJson(ctx, res, 400, 'Problems parsing JSON');
  const body = parsed.value;
  if (Array.isArray(body)) {
    const results = body.map((operation) =>
      executeGraphQL(ctx.store, typeof operation?.query === 'string' ? operation.query : '', operation?.variables ?? {}, operation?.operationName),
    );
    return sendJson(ctx, res, 200, results);
  }
  const result = executeGraphQL(
    ctx.store,
    typeof body?.query === 'string' ? body.query : '',
    body?.variables ?? {},
    typeof body?.operationName === 'string' ? body.operationName : undefined,
  );
  return sendJson(ctx, res, 200, result);
}

// ---------------------------------------------------------------- MCP

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

// tools/list must be byte-identical across calls: one frozen constant, serialized as-is.
const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner login and repository name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all (default open)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request proposing changes from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

class ToolFailure extends Error {}

/** Branch arguments may arrive as `owner:branch` (the REST convention); strip the prefix. */
function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function mcpRepoObject(store: Store, repo: Repo): any {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function mcpIssueObject(issue: Issue): any {
  return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
}

function mcpPullObject(repo: Repo, pull: Pull): any {
  return {
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head },
    base: { ref: pull.base },
    merged: pull.merged,
  };
}

function callMcpTool(store: Store, name: string, args: Record<string, any>): any {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (store.getRepo(store.viewer.login, repoName)) throw new ToolFailure(`Repository ${repoName} already exists`);
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if (!repo) throw new ToolFailure(`Repository ${repoName} already exists`);
      return mcpRepoObject(store, repo);
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) throw new ToolFailure('Repository not found');
      return mcpRepoObject(store, repo);
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) throw new ToolFailure('Repository not found');
      const issue = store.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
      });
      return mcpIssueObject(issue);
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) throw new ToolFailure('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      return [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map(mcpIssueObject);
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) throw new ToolFailure('Repository not found');
      const head = stripOwnerPrefix(String(args.head ?? ''));
      const base = stripOwnerPrefix(String(args.base ?? repo.defaultBranch));
      if (!store.refTip(repo, head)) throw new ToolFailure(`Head branch ${head} not found`);
      if (!store.refTip(repo, base)) throw new ToolFailure(`Base branch ${base} not found`);
      const existing = store.openPullFor(repo, head, base);
      const pull =
        existing ??
        store.createPull(repo, {
          title: String(args.title ?? ''),
          body: typeof args.body === 'string' ? args.body : '',
          head,
          base,
        });
      return mcpPullObject(repo, pull);
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) throw new ToolFailure('Repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) throw new ToolFailure('Pull request not found');
      if (pull.merged) return { sha: pull.mergeCommitSha ?? '', merged: true, message: 'Pull Request successfully merged' };
      const outcome = mergePull(store, repo, pull);
      if (!outcome.ok) throw new ToolFailure(outcome.reason === 'conflict' ? 'Merge conflict: cannot merge this pull request' : 'Pull request is not open');
      return { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' };
    }
    default:
      return null; // unreachable: dispatch validates the tool name first
  }
}

function rpcResult(id: any, result: any): any {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: any, code: number, message: string): any {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleMcpMessage(ctx: Ctx, message: any): { status: number; body: any | null } {
  if (Array.isArray(message)) {
    const responses: any[] = [];
    for (const item of message) {
      const handled = handleMcpMessage(ctx, item);
      if (handled.body !== null) responses.push(handled.body);
    }
    return { status: 200, body: responses };
  }
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined;
  const id = hasId ? message.id : null;
  const method: string = message.method;
  const params: any = message.params ?? {};

  if (!hasId) {
    // A notification: acknowledged with 202 and no body.
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: '2026-07-28',
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
    case 'resources/list':
      return { status: 200, body: rpcResult(id, { resources: [] }) };
    case 'prompts/list':
      return { status: 200, body: rpcResult(id, { prompts: [] }) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
      const args: Record<string, any> = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return { status: 200, body: rpcError(id, -32602, `Missing required argument: ${required}`) };
        }
      }
      try {
        const output = callMcpTool(ctx.store, toolName, args);
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
            isError: false,
          }),
        };
      } catch (error) {
        const text = error instanceof Error ? error.message : 'tool execution failed';
        return {
          status: 200,
          body: rpcResult(id, { content: [{ type: 'text', text }], isError: true }),
        };
      }
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  if (!authed(ctx, req)) {
    sendJson(ctx, res, 401, rpcError(null, -32001, 'Unauthorized'));
    return;
  }
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': `FORGE-${ctx.requestId}` });
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendJson(ctx, res, 405, rpcError(null, -32601, 'Method not allowed'));
    return;
  }
  let message: any;
  try {
    message = JSON.parse(raw.toString('utf8'));
  } catch {
    // Modern-era parse errors are HTTP 400 with the JSON-RPC parse error code.
    sendJson(ctx, res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const handled = handleMcpMessage(ctx, message);
  if (handled.body === null) {
    res.writeHead(handled.status, { 'x-github-request-id': `FORGE-${ctx.requestId}` });
    res.end();
    return;
  }
  sendJson(ctx, res, handled.status, handled.body);
}

// ---------------------------------------------------------------- git HTTP routing

function handleInfoRefs(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  owner: string,
  repoName: string,
): void {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return errJson(ctx, res, 404, 'Not Found');
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) return errJson(ctx, res, 404, 'Not Found');
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const advertisement = isV2 ? v2Advertisement() : v0Advertisement(ctx.store, repo, service);
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache',
    'x-github-request-id': `FORGE-${ctx.requestId}`,
  });
  res.end(advertisement);
}

// ---------------------------------------------------------------- app

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let counter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const ctx: Ctx = { store, token, requestId: ++counter };
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.local');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        if (path === '/api/graphql') {
          const raw = await readBody(req);
          return handleGraphQL(ctx, req, res, raw);
        }
        if (path === '/mcp') {
          const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          return handleMcp(ctx, req, res, raw);
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          return handleRest(ctx, req, res, url, raw);
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const rest = gitMatch[3] ?? '';
          if (rest === '/info/refs' && method === 'GET') return handleInfoRefs(ctx, req, res, url, owner, repoName);
          if ((rest === '/git-upload-pack' || rest === '/git-receive-pack') && method === 'POST') {
            const repo = store.getRepo(owner, repoName);
            if (!repo) return errJson(ctx, res, 404, 'Not Found');
            const raw = await readBody(req);
            if (rest === '/git-upload-pack') return handleUploadPack(ctx, req, res, repo, raw);
            return handleReceivePack(ctx, res, repo, raw);
          }
          return errJson(ctx, res, 404, 'Not Found');
        }
        return errJson(ctx, res, 404, 'Not Found');
      } catch (error) {
        console.error('forge: request failed:', error);
        // The server must stay up: a malformed request costs one response, never the process.
        if (!res.headersSent) {
          try {
            errJson(ctx, res, 500, 'Internal Server Error');
          } catch {
            // response already gone
          }
        } else {
          try {
            res.end();
          } catch {
            // response already gone
          }
        }
      }
    })();
  });
  return server;
}
