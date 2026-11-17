// Git smart HTTP: info/refs advertisement (protocol v0 and v2), ls-refs, fetch (upload-pack)
// and push (receive-pack), over the real git object model.

import {
  PKT_DELIM,
  PKT_FLUSH,
  commitClosure,
  commitOf,
  flattenTree,
  isAncestor,
  parsePktLines,
  parsePktLinesPrefix,
  peelToCommit,
  pktLine,
  readPack,
  treeEntriesOf,
  writePack,
  ZERO_OID,
  type PktPacket,
} from './gitobj.ts';
import { fail, sendRaw, type Ctx } from './http.ts';
import { headRef, type RepoRec } from './store.ts';

const AGENT = 'makefun-forge/1.0';

function wantsV2(ctx: Ctx): boolean {
  const header = ctx.req.headers['git-protocol'];
  return typeof header === 'string' && header.includes('version=2');
}

/** Sorted ref entries with peeled tag targets, as advertised. */
function advertisedRefs(repo: RepoRec): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object !== undefined && object.type === 'tag') {
      peeled = peelToCommit(repo.objects, oid) ?? undefined;
    }
    out.push({ name, oid, peeled });
  }
  return out;
}

function handleInfoRefs(ctx: Ctx, repo: RepoRec, service: string): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    fail(ctx, 400, 'Unknown service');
    return;
  }
  if (wantsV2(ctx)) {
    const lines = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    sendRaw(ctx, 200, body, { 'content-type': `application/x-${service}-advertisement` });
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not symref=HEAD:${headRef(repo)} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  const headTarget = headRef(repo);
  const headOid = repo.refs.get(headTarget);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  sendRaw(ctx, 200, Buffer.concat(parts), { 'content-type': `application/x-${service}-advertisement` });
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(ctx: Ctx, repo: RepoRec, packets: PktPacket[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const target = headRef(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:${target}` : `${headOid} HEAD`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${target}`);
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  sendRaw(ctx, 200, body, { 'content-type': 'application/x-git-upload-pack-result' });
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenSince?: number;
  done: boolean;
}

function parseFetchArgs(packets: PktPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface Selection {
  commits: string[];
  objects: string[];
  shallowLines: string[];
  unshallowLines: string[];
}

function selectObjects(repo: RepoRec, args: FetchArgs): Selection {
  const store = repo.objects;
  // Resolve wants: tag objects peel to commits but are sent themselves.
  const wantCommits: string[] = [];
  const extraObjects: string[] = [];
  for (const want of args.wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') wantCommits.push(want);
    else if (object.type === 'tag') {
      extraObjects.push(want);
      const peeled = peelToCommit(store, want);
      if (peeled !== null) wantCommits.push(peeled);
    }
  }
  // A have the client also lists as shallow is a boundary commit: the client holds that commit
  // and its tree, but NOT its ancestry — a deepen must be able to deliver its parents. Only
  // non-shallow haves imply possession of their whole closure.
  const shallowSet = new Set(args.shallow.filter((oid) => store.has(oid)));
  const haveCommits = new Set<string>();
  for (const have of args.haves) {
    if (shallowSet.has(have)) continue;
    const object = store.get(have);
    if (object !== undefined && object.type === 'commit') {
      for (const oid of commitClosure(store, [have])) haveCommits.add(oid);
    }
  }
  // BFS by generation from the wants.
  const included = new Map<string, number>();
  let frontier = [...new Set(wantCommits)];
  for (const oid of frontier) included.set(oid, 0);
  let generation = 0;
  const limit = args.deepen !== undefined && Number.isFinite(args.deepen) ? Math.max(0, Math.trunc(args.deepen)) : Number.POSITIVE_INFINITY;
  while (frontier.length > 0) {
    generation += 1;
    if (generation >= limit) break;
    const next: string[] = [];
    for (const oid of frontier) {
      const commit = commitOf(store, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (included.has(parent) || haveCommits.has(parent)) continue;
        if (args.deepenSince !== undefined) {
          const parentCommit = commitOf(store, parent);
          if (parentCommit !== null && parentCommit.committerTs <= args.deepenSince) continue;
        }
        included.set(parent, generation);
        next.push(parent);
      }
    }
    frontier = next;
  }
  // Shallow boundary: included commits with a parent that exists but was cut by the depth limit.
  const shallowLines: string[] = [];
  const limited = limit !== Number.POSITIVE_INFINITY || args.deepenSince !== undefined;
  if (limited) {
    for (const oid of included.keys()) {
      const commit = commitOf(store, oid);
      if (commit === null) continue;
      const cut = commit.parents.some((parent) => !included.has(parent) && !haveCommits.has(parent) && store.has(parent));
      if (cut) shallowLines.push(oid);
    }
  }
  const unshallowLines: string[] = [];
  for (const oid of args.shallow) {
    if (!included.has(oid)) continue;
    const commit = commitOf(store, oid);
    if (commit === null) continue;
    if (commit.parents.every((parent) => included.has(parent) || haveCommits.has(parent))) unshallowLines.push(oid);
  }
  // Object set: included commits plus their full trees, minus everything the client already has:
  // the full haves' closures, and each shallow boundary commit's own object and tree.
  const possessed = new Set<string>([...haveCommits, ...shallowSet]);
  const haveObjects = new Set<string>(possessed);
  for (const oid of possessed) {
    const commit = commitOf(store, oid);
    if (commit === null) continue;
    for (const path of flattenTree(store, commit.tree).values()) haveObjects.add(path.oid);
    collectTreeObjects(store, commit.tree, haveObjects);
  }
  const objects: string[] = [];
  const seen = new Set<string>();
  const push = (oid: string): void => {
    if (seen.has(oid) || haveObjects.has(oid)) return;
    if (!store.has(oid)) return;
    seen.add(oid);
    objects.push(oid);
  };
  for (const oid of extraObjects) push(oid);
  for (const oid of included.keys()) {
    push(oid);
    const commit = commitOf(store, oid);
    if (commit === null) continue;
    const treeObjects: string[] = [];
    collectTreeObjects(store, commit.tree, new Set(), treeObjects);
    for (const treeOid of treeObjects) push(treeOid);
    for (const entry of flattenTree(store, commit.tree).values()) push(entry.oid);
  }
  return { commits: [...included.keys()], objects, shallowLines, unshallowLines };
}

function collectTreeObjects(store: RepoRec['objects'], treeOid: string, into: Set<string>, list?: string[]): void {
  if (into.has(treeOid)) return;
  into.add(treeOid);
  if (list !== undefined) list.push(treeOid);
  for (const entry of treeEntriesOf(store, treeOid)) {
    if (entry.mode === '40000') collectTreeObjects(store, entry.oid, into, list);
  }
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte header; the band byte takes one more.
  const CHUNK = 65520 - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, offset + CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

function handleFetchV2(ctx: Ctx, repo: RepoRec, packets: PktPacket[]): void {
  const args = parseFetchArgs(packets);
  const selection = selectObjects(repo, args);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const common = args.haves.find((have) => repo.objects.has(have));
  if (args.haves.length === 0 || common === undefined) {
    parts.push(pktLine('NAK\n'));
  } else {
    parts.push(pktLine(`ACK ${common}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (selection.shallowLines.length > 0 || selection.unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(repo.objects, selection.objects);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendRaw(ctx, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
}

function handleUploadPackV0(ctx: Ctx, repo: RepoRec, body: Buffer): void {
  let packets: PktPacket[] = [];
  try {
    packets = parsePktLines(body);
  } catch {
    packets = [];
  }
  const wants: string[] = [];
  const haves: string[] = [];
  let caps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const selection = selectObjects(repo, { wants, haves, shallow: [], done: true });
  const pack = writePack(repo.objects, selection.objects);
  const parts: Buffer[] = [pktLine('NAK\n'), PKT_FLUSH];
  if (caps.includes('side-band-64k')) parts.push(...sidebandPackets(pack));
  else parts.push(pack);
  sendRaw(ctx, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
}

function handleUploadPack(ctx: Ctx, repo: RepoRec): void {
  if (wantsV2(ctx)) {
    let packets: PktPacket[];
    try {
      packets = parsePktLines(ctx.body);
    } catch {
      fail(ctx, 400, 'Malformed pkt-line stream');
      return;
    }
    const commandLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8') ?? '';
    if (commandLine.startsWith('command=ls-refs')) {
      handleLsRefs(ctx, repo, packets);
      return;
    }
    if (commandLine.startsWith('command=fetch')) {
      handleFetchV2(ctx, repo, packets);
      return;
    }
    fail(ctx, 400, 'Unknown command');
    return;
  }
  handleUploadPackV0(ctx, repo, ctx.body);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: Ctx, repo: RepoRec): void {
  let packets: PktPacket[];
  let consumed = 0;
  try {
    const parsed = parsePktLinesPrefix(ctx.body);
    packets = parsed.packets;
    consumed = parsed.consumed;
  } catch {
    fail(ctx, 400, 'Malformed pkt-line stream');
    return;
  }
  const commands: PushCommand[] = [];
  let clientCaps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      clientCaps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = ctx.body.subarray(Math.min(consumed, ctx.body.length));
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      readPack(repo.objects, packBytes);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyPushCommand(repo, command));
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack error ${unpackDetail}`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'failed'}`);
  }
  const stream = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  let body: Buffer;
  if (clientCaps.includes('side-band-64k')) {
    const chunks: Buffer[] = [];
    const CHUNK = 65520 - 4 - 1;
    for (let offset = 0; offset < stream.length; offset += CHUNK) {
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), stream.subarray(offset, offset + CHUNK)])));
    }
    chunks.push(PKT_FLUSH);
    body = Buffer.concat(chunks);
  } else {
    body = stream;
  }
  sendRaw(ctx, 200, body, { 'content-type': 'application/x-git-receive-pack-result' });
}

function applyPushCommand(repo: RepoRec, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const { ref, newOid } = command;
  if (newOid === ZERO_OID) {
    if (!repo.refs.has(ref)) return { ref, ok: false, reason: 'reference not found' };
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  const object = repo.objects.get(newOid);
  if (object === undefined) return { ref, ok: false, reason: 'missing object' };
  if (object.type !== 'commit' && object.type !== 'tag') return { ref, ok: false, reason: 'invalid object' };
  const current = repo.refs.get(ref);
  if (current !== undefined && current !== newOid) {
    const currentCommit = peelToCommit(repo.objects, current);
    const newCommit = peelToCommit(repo.objects, newOid);
    if (currentCommit === null || newCommit === null || !isAncestor(repo.objects, currentCommit, newCommit)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}

// ---------------------------------------------------------------- entry

/** Handle /{owner}/{repo}.git/... routes. Segments are the full path segments. */
export function handleGit(ctx: Ctx, segments: string[]): boolean {
  if (segments.length < 3) return false;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return false;
  const name = repoSegment.slice(0, -'.git'.length);
  const route = segments.slice(2).join('/');
  if (route !== 'info/refs' && route !== 'git-upload-pack' && route !== 'git-receive-pack') return false;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === null) {
    fail(ctx, 404, 'Not Found');
    return true;
  }
  try {
    if (route === 'info/refs') {
      handleInfoRefs(ctx, repo, ctx.url.searchParams.get('service') ?? '');
    } else if (route === 'git-upload-pack') {
      if (ctx.method !== 'POST') {
        fail(ctx, 405, 'Method Not Allowed');
        return true;
      }
      handleUploadPack(ctx, repo);
    } else {
      if (ctx.method !== 'POST') {
        fail(ctx, 405, 'Method Not Allowed');
        return true;
      }
      handleReceivePack(ctx, repo);
    }
  } catch {
    // A malformed request must never take the server down.
    if (!ctx.res.headersSent) fail(ctx, 400, 'Bad Request');
  }
  return true;
}
