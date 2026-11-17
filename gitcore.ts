// gitcore.ts — the git object model, packfiles and pkt-line codec, in pure TypeScript.
// No git binary, no dependencies: SHA-1 from node:crypto, zlib from node:zlib.
// Written for the github-core-clone-01 forge (see app.ts / store.ts).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** committer timestamp in unix seconds, 0 when unparsable. */
  timestamp: number;
}

function identTimestamp(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident);
  return match ? Number(match[1]) : 0;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, timestamp: identTimestamp(committer || author) };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer?: string;
  timestamp: number;
}): Buffer {
  const who = `${fields.author} ${fields.timestamp} +0000`;
  const committer = `${fields.committer ?? fields.author} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const fields = new Map<string, string>();
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: fields.get('object') ?? '', type: fields.get('type') ?? '', tag: fields.get('tag') ?? '' };
}

/** Follow tag objects to the commit they ultimately name; null when not a commit chain. */
export function peelToCommit(
  lookup: (oid: string) => GitObject | undefined,
  oid: string,
): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
    if (!isOid(current)) return null;
  }
  return null;
}

// ---------------------------------------------------------------- deltas

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: wants ${sourceSize}, has ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of base');
      if (written + copySize > targetSize) throw new Error('delta writes past target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert truncated');
      if (written + literal > targetSize) throw new Error('delta writes past target');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset` inside `buffer` (bounded by `end`); returns bytes + next offset. */
function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export interface PackRead {
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA recursively.
 * `resolveExternal` supplies bases a thin pack leaves out (objects the store already holds).
 */
export function readPack(pack: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta base offset invalid');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let resolved: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      let base: GitObject;
      if (baseEntry) base = resolve(baseEntry);
      else {
        const external = resolveExternal?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} not available`);
        base = external;
      }
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    entry.resolved = resolved;
    entry.oid = hashObject(resolved.type, resolved.data);
    resolvedByOid.set(entry.oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    const oid = hashObject(resolved.type, resolved.data);
    if (!objects.has(oid)) objects.set(oid, resolved);
  }
  return { objects, count: declared };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): correctness first, and small packs stay fast. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pkt-line

export const PKT_MAX_PAYLOAD = 65520 - 4;

export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the front of `buffer`. Returns the packets and how many bytes they
 * consumed; any trailing bytes (e.g. a receive-pack packfile after the flush) are left over.
 * Throws on a malformed frame.
 */
export function decodePkts(buffer: Buffer, startAt = 0): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = startAt;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break; // a flush ends the pkt-line stream for our protocols; the rest is raw
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4) throw new Error(`pkt-line length ${length} is invalid`);
    if (offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset - startAt };
}

/** Decode a complete pkt-line stream (upload-pack v2 requests end with a flush). */
export function decodePktStream(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Frame `data` as side-band-64k band-1 packets (splitting at the pkt-line payload limit). */
export function sidebandPackets(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const prefix = Buffer.from([band]);
  let offset = 0;
  if (data.length === 0) return Buffer.alloc(0);
  while (offset < data.length) {
    const take = Math.min(data.length - offset, PKT_MAX_PAYLOAD - 1);
    parts.push(encodePkt(Buffer.concat([prefix, data.subarray(offset, offset + take)])));
    offset += take;
  }
  return Buffer.concat(parts);
}
