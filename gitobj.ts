// Git object model: real SHA-1 git objects, pack read/write, pkt-lines, ancestry and merges.
// Node standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'tag', 7: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(store: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}

function parseIdent(line: string): { name: string; email: string; ts: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', ts: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', ts: Number(match[3] ?? 0) };
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = { name: '', email: '', ts: 0 };
  let committer = { name: '', email: '', ts: 0 };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdent(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdent(line.slice(10));
  }
  return {
    tree,
    parents,
    authorName: author.name,
    authorEmail: author.email,
    authorTs: author.ts,
    committerName: committer.name,
    committerEmail: committer.email,
    committerTs: committer.ts,
    message,
  };
}

export interface Identity {
  name: string;
  email: string;
}

export function buildCommitData(input: {
  tree: string;
  parents: string[];
  message: string;
  author: Identity;
  committer: Identity;
  ts: number;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author.name} <${input.author.email}> ${input.ts} +0000`);
  lines.push(`committer ${input.committer.name} <${input.committer.email}> ${input.ts} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directory names compare as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
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

/** Flatten a tree into path -> blob entry, recursing into subtrees. */
export function flattenTree(store: Map<string, GitObject>, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild a tree hierarchy from a flat path -> blob map; returns the root tree oid. */
export function unflattenTree(store: Map<string, GitObject>, files: Map<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(store, 'tree', buildTreeData(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- tags

export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : (match[1] as string);
}

/** Follow tag objects to the commit they ultimately name; null when unreachable. */
export function peelToCommit(store: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const target = parseTagTarget(object.data);
      if (target === null) return null;
      current = target;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- ancestry

export function commitOf(store: Map<string, GitObject>, oid: string): CommitInfo | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** All commits reachable from `tips` (inclusive), following parents. */
export function commitClosure(store: Map<string, GitObject>, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = commitOf(store, oid);
    if (commit === null) continue;
    seen.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(store: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitClosure(store, [descendant]).has(ancestor);
}

/** A best common ancestor of two commits (BFS from both), or null. */
export function mergeBase(store: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = commitClosure(store, [a]);
  if (fromA.has(b)) return b;
  const fromB = commitClosure(store, [b]);
  if (fromB.has(a)) return a;
  // BFS from b in history order, first commit also reachable from a.
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const commit = commitOf(store, oid);
    if (commit !== null) queue.push(...commit.parents);
  }
  return null;
}

/** Commits reachable from `tip`, newest first (DFS pre-order over parents, deduped). */
export function listCommits(store: Map<string, GitObject>, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const commit = commitOf(store, oid);
    if (commit === null) return;
    seen.add(oid);
    out.push(oid);
    for (const parent of commit.parents) visit(parent);
  };
  visit(tip);
  return out;
}

// ---------------------------------------------------------------- packs

function encodeObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
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

/** Write a version-2 pack of the given objects (plain objects, no deltas). */
export function writePack(store: Map<string, GitObject>, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) continue;
    parts.push(encodeObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = data[pos] as number;
    pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const source = readVarint(delta, pos);
  pos = source.next;
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const target = readVarint(delta, pos);
  pos = target.next;
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      written += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (written !== target.value || result.length !== target.value) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/** Parse a pack into the store, resolving OFS/REF deltas. Returns the object ids added. */
export function readPack(store: Map<string, GitObject>, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: { oid?: string; entry: PackEntry; start: number }[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      entry = { type: 'commit', data: inflated.data, baseOffset: start - back };
      offset = inflated.next;
    } else if (typeCode === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateAt(pack, offset);
      entry = { type: 'commit', data: inflated.data, baseOid };
      offset = inflated.next;
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      entry = { type, data: inflated.data };
      offset = inflated.next;
    }
    if (entry.data.length !== size && entry.baseOid === undefined && entry.baseOffset === undefined) {
      // Size in the header is the inflated size of the stored representation; for plain objects it
      // must match. (For deltas it is the delta's own size, which also matches.)
      if (entry.data.length !== size) throw new Error('pack object size mismatch');
    }
    byOffset.set(start, entries.length);
    entries.push({ entry, start });
  }
  // Resolve in passes: plain objects first, then deltas against known bases.
  const resolved: (string | undefined)[] = entries.map(() => undefined);
  let progress = true;
  let guard = 0;
  while (progress && guard < entries.length + 2) {
    progress = false;
    guard += 1;
    for (let i = 0; i < entries.length; i += 1) {
      if (resolved[i] !== undefined) continue;
      const { entry } = entries[i] as { entry: PackEntry; start: number };
      if (entry.baseOid === undefined && entry.baseOffset === undefined) {
        resolved[i] = storeObject(store, entry.type, entry.data);
        progress = true;
        continue;
      }
      let base: GitObject | undefined;
      let baseType: GitObjectType | undefined;
      if (entry.baseOid !== undefined) {
        base = store.get(entry.baseOid);
        baseType = base?.type;
      } else if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex !== undefined && resolved[baseIndex] !== undefined) {
          base = store.get(resolved[baseIndex] as string);
          baseType = base?.type;
        }
      }
      if (base === undefined || baseType === undefined) continue;
      const data = applyDelta(base.data, entry.data);
      resolved[i] = storeObject(store, baseType, data);
      progress = true;
    }
  }
  const added: string[] = [];
  for (const oid of resolved) {
    if (oid === undefined) throw new Error('pack delta base unresolved');
    added.push(oid);
  }
  return added;
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + consumed };
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Parse pkt-lines until the first flush packet, reporting how many bytes were consumed.
 * Trailing bytes (a receive-pack's packfile) are left untouched and never parsed.
 */
export function parsePktLinesPrefix(buffer: Buffer): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const headerText = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) throw new Error('invalid pkt-line length');
    const length = parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets, consumed: offset };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** Parse every pkt-line in a buffer; throws on malformed framing. */
export function parsePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const headerText = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) throw new Error('invalid pkt-line length');
    const length = parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}
