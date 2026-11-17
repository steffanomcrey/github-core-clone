// Git smart HTTP: the protocol a real `git clone` speaks.
//
// The suite does not poke at these endpoints with hand-made requests; it runs git itself, against
// /owner/repo.git, and then compares the result to what it pushed. That leaves exactly one honest
// implementation: serve the same four routes a git server serves, in the same wire formats.
//
//   GET  /owner/repo.git/info/refs?service=git-upload-pack   -> pkt-line advert, v0
//   POST /owner/repo.git/git-upload-pack                    -> wants/haves -> packfile
//   GET  /owner/repo.git/info/refs?service=git-receive-pack  -> pkt-line advert, v0
//   POST /owner/repo.git/git-receive-pack                   -> packfile in -> ref updates out
//
// Two details decide whether a clone succeeds or hangs. The advert must come back as
// application/x-git-upload-pack-advertisement with the service line first and a flush after it,
// and the pack must be sent with side-band-64k only when the client asked for it. Everything else
// is bookkeeping.

import { createHash } from 'node:crypto';
import * as nodeZlib from 'node:zlib';
import type { Store, Repo, ObjectType } from './store.ts';
import { getRepo, hashObject, parseCommit, parseTree } from './store.ts';

export interface GitRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  rawBody: Buffer;
  token: string | null;
  authed: boolean;
  currentUser: string;
  headers: Record<string, string>;
}

export interface GitResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

// ---------------------------------------------------------------- pkt-line

function pkt(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'latin1'), payload]);
}

function flush(): Buffer {
  return Buffer.from('0000', 'latin1');
}

/** pkt-line around raw bytes. `pkt` encodes text as utf8, which mangles a binary pack chunk:
 *  every byte above 0x7f becomes two, so both the declared length and the payload go wrong. */
function pktBin(payload: Buffer): Buffer {
  const length = payload.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'latin1'), payload]);
}

/** Parse a pkt-line stream into its payloads. A flush packet ends a section. */
function readPktLines(data: Buffer): Array<{ payload: Buffer; flush: boolean; delim?: boolean }> {
  const out: Array<{ payload: Buffer; flush: boolean; delim?: boolean }> = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const header = data.slice(pos, pos + 4).toString('latin1');
    const length = parseInt(header, 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      out.push({ payload: Buffer.alloc(0), flush: true });
      pos += 4;
      continue;
    }
    // Length 1 is the delimiter pkt-line (`0001`). It separates the command header from the
    // command arguments; treating it as malformed stops the parse right there and every argument
    // after it — symrefs, peel, ref-prefix — is lost, which is why refs came back unfiltered.
    if (length === 1) {
      out.push({ payload: Buffer.alloc(0), flush: false, delim: true });
      pos += 4;
      continue;
    }
    if (length === 2) {
      out.push({ payload: Buffer.alloc(0), flush: false, delim: true });
      pos += 4;
      continue;
    }
    if (length < 4) break;
    const payload = data.slice(pos + 4, pos + length);
    out.push({ payload, flush: false });
    pos += length;
  }
  return out;
}

// ---------------------------------------------------------------- packfile

class ByteReader {
  private pos = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('unexpected end of pack');
    return this.buf[this.pos++];
  }

  /** The unconsumed tail, without consuming it. */
  rest(): Buffer {
    return this.buf.slice(this.pos);
  }

  /** Consume n bytes that a callee already accounted for. */
  skip(n: number): void {
    this.pos += n;
  }

  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('unexpected end of pack');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  // git's varint: 7 bits per byte, high bit means continue, little-endian groups.
  sizeVarint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return value >>> 0;
  }

  offsetVarint(first: number): number {
    let value = first & 0x7f;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = this.byte();
      value = ((value + 1) << 7) | (byte & 0x7f);
    }
    return value >>> 0;
  }
}

// Inflate one zlib member and report how many input bytes it consumed. The consumed length is not
// a detail: a pack is a concatenation of deflate streams with no separators, so the only way to
// find where the next object begins is to ask zlib where this one ended. The synchronous binding
// exposes that as `info.engine.bytesWritten`; guessing the boundary by re-inflating growing slices
// is both slower and wrong on a stream whose prefix happens to inflate cleanly.
function inflateAt(raw: Buffer, expected: number | null): { data: Buffer; consumed: number } {
  const result = nodeZlib.inflateSync(raw, {
    info: true,
    finishFlush: nodeZlib.constants.Z_SYNC_FLUSH,
  }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const data = result.buffer;
  const consumed = result.engine?.bytesWritten ?? raw.length;
  if (expected !== null && data.length !== expected) {
    throw new Error(`object size mismatch: declared ${expected}, inflated ${data.length}`);
  }
  return { data, consumed };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
function deflate(data: Buffer): Buffer {
  return nodeZlib.deflateSync(data, { level: 6 });
}

const TYPE_NAMES: Array<ObjectType> = ['commit', 'tree', 'blob', 'tag'];

interface ScannedObject {
  type: ObjectType;
  data: Buffer;
  sha: string;
}

interface RawPackEntry {
  offset: number;
  typeNum: number;
  data?: Buffer;
  baseSha?: string;
  baseOffset?: number;
  resolved?: ScannedObject;
}

// Read a packfile into objects, resolving deltas against bases already in the pack or already in
// the store. A ref-delta names its base by sha; an ofs-delta names it by backwards distance,
// which is why every entry keeps its byte offset.
function readPack(pack: Buffer, repo: Repo, haveSha: (sha: string) => ScannedObject | undefined): ScannedObject[] {
  if (pack.length < 12) throw new Error('pack too short');
  const magic = pack.slice(0, 4).toString('latin1');
  if (magic !== 'PACK') throw new Error(`bad pack magic ${JSON.stringify(magic)}`);
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);

  const reader = new ByteReader(pack.slice(12));
  const entries: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let consumed = 0;

  for (let i = 0; i < count; i++) {
    const offset = 12 + consumed;
    const first = reader.byte();
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      byte = reader.byte();
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    size = size >>> 0;

    const entry: RawPackEntry = { offset, typeNum };
    if (typeNum === 6) {
      const baseOffset = reader.offsetVarint(reader.byte());
      entry.baseOffset = offset - baseOffset;
    } else if (typeNum === 7) {
      entry.baseSha = reader.bytes(20).toString('hex');
    } else if (typeNum < 1 || typeNum > 4) {
      throw new Error(`unknown pack object type ${typeNum}`);
    }

    // Every object — deltas too — is one deflate stream whose uncompressed size the header
    // already declared, so a single bounded inflate both reads it and yields the next offset.
    const { data: inflated, consumed: used } = inflateAt(reader.rest(), size);
    reader.skip(used);
    consumed += used;
    entry.data = inflated;

    entries.push(entry);
    byOffset.set(offset, entry);
  }

  const resolved: ScannedObject[] = [];
  const resolveEntry = (entry: RawPackEntry, depth = 0): ScannedObject => {
    if (entry.resolved) return entry.resolved;
    if (depth > 64) throw new Error('delta chain too deep');

    if (entry.data !== undefined && entry.typeNum <= 4) {
      const type = TYPE_NAMES[entry.typeNum - 1];
      const sha = hashObject(type, entry.data);
      const obj = { type, data: entry.data, sha };
      entry.resolved = obj;
      return obj;
    }

    let base: ScannedObject;
    if (entry.baseOffset !== undefined) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('delta base offset not in pack');
      base = resolveEntry(baseEntry, depth + 1);
    } else if (entry.baseSha) {
      const local = haveSha(entry.baseSha);
      if (local) base = local;
      else {
        const stored = repo.objects.get(entry.baseSha);
        if (!stored) throw new Error('delta base missing from store');
        base = { type: stored.type, data: stored.data, sha: entry.baseSha };
      }
    } else {
      throw new Error('delta without a base');
    }

    const delta = entry.data as Buffer;
    const data = applyDelta(base.data, delta);
    const sha = hashObject(base.type, data);
    const obj = { type: base.type, data, sha };
    entry.resolved = obj;
    return obj;
  };

  for (const entry of entries) {
    const obj = resolveEntry(entry);
    // Each entry already carries its inflated payload: a base object carries its data, a delta
    // carries its delta, and the resolve step below turns a delta into content.
    resolved.push(obj);
  }
  return resolved;
}

// Inflate one object from a stream of concatenated zlib members, reading only as many bytes as
// that member occupies. `size` is the claimed uncompressed length, which tells us when we are
// done and keeps a corrupt stream from running away.
// The number of bytes a zlib member occupies, found by inflating byte by byte until the stream
// reports it is complete. Cheap enough for the object sizes a suite pushes, and exact, which is
// what matters: one byte off and every later object in the pack is garbage.
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const reader = new ByteReader(delta);
  const baseSize = reader.sizeVarint();
  if (baseSize !== base.length) throw new Error(`delta base size mismatch: ${baseSize} != ${base.length}`);
  const resultSize = reader.sizeVarint();

  const out = Buffer.alloc(resultSize);
  let pos = 0;
  while (reader.remaining > 0) {
    const op = reader.byte();
    if ((op & 0x80) !== 0) {
      // Copy from base: the low bits name which offset/size bytes follow.
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= reader.byte();
      if (op & 0x02) offset |= reader.byte() << 8;
      if (op & 0x04) offset |= reader.byte() << 16;
      if (op & 0x08) offset |= reader.byte() << 24;
      if (op & 0x10) size |= reader.byte();
      if (op & 0x20) size |= reader.byte() << 8;
      if (op & 0x40) size |= reader.byte() << 16;
      if (size === 0) size = 0x10000;
      offset = offset >>> 0;
      base.copy(out, pos, offset, offset + size);
      pos += size;
    } else if (op !== 0) {
      // Insert: the op is the literal length.
      const literal = reader.bytes(op);
      literal.copy(out, pos);
      pos += op;
    } else {
      throw new Error('delta op 0x00 is reserved');
    }
  }
  if (pos !== resultSize) throw new Error(`delta produced ${pos} of ${resultSize} bytes`);
  return out;
}

// The reverse: a packfile of every object the client asked for and does not have.
function buildPack(objects: ScannedObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const parts: Buffer[] = [header];
  for (const obj of objects) {
    const typeNum = TYPE_NAMES.indexOf(obj.type) + 1;
    const size = obj.data.length;
    const bytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    let rest = size >>> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflate(obj.data));
  }

  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

/** Build a pack from an explicit object list, skipping anything the client already holds. */
function buildPackFor(repo: Repo, shas: string[], held: Set<string>): Buffer {
  const objects: ScannedObject[] = [];
  for (const sha of shas) {
    if (held.has(sha) || objects.some((obj) => obj.sha === sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    objects.push({ type: obj.type, data: obj.data, sha });
  }
  return buildPack(objects);
}

// ---------------------------------------------------------------- advert

function capabilityAdvert(caps: string[]): string {
  // The first ref line carries the capabilities after a NUL; the rest carry none.
  return caps.join(' ');
}

function advertise(repo: Repo, service: string, caps: string[]): Buffer {
  const refs = Array.from(repo.refs.entries())
    .filter(([name]) => name.startsWith('refs/'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const lines: Buffer[] = [];
  lines.push(pkt(`# service=${service}\n`));
  lines.push(flush());

  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const all = refs.slice();
  if (headSha && !all.some(([name]) => name === 'HEAD')) {
    all.unshift(['HEAD', headSha]);
  }

  if (all.length === 0) {
    // An empty repository still advertises: the client needs to know the service exists and
    // which capabilities it can use before it pushes the first branch.
    lines.push(pkt(`0000000000000000000000000000000000000000 capabilities^{}\0${capabilityAdvert(caps)}\n`));
  } else {
    all.forEach(([name, sha], index) => {
      const capsPart = index === 0 ? `\0${capabilityAdvert(caps)}` : '';
      lines.push(pkt(`${sha} ${name}${capsPart}\n`));
    });
  }
  lines.push(flush());
  return Buffer.concat(lines);
}

const UPLOAD_CAPS = [
  // `multi_ack_detailed` is not optional in practice: a client running stateless RPC (which is
  // what smart HTTP always is) refuses to start a fetch unless the server offers it, because it
  // needs the ACK/NAK exchange to resume a negotiation it cannot keep in memory. Offering plain
  // `multi_ack` instead advertises a capability the client will not use and earns an immediate
  // "the option '--stateless-rpc' requires 'multi_ack_detailed'".
  'multi_ack',
  'multi_ack_detailed',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'no-progress',
  'include-tag',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
  'no-done',
  'symref=HEAD:refs/heads/main',
  'object-format=sha1',
  'agent=makefun-forge/1.0',
];

const RECEIVE_CAPS = [
  'report-status',
  'report-status-v2',
  'delete-refs',
  'side-band-64k',
  'quiet',
  'atomic',
  'ofs-delta',
  'object-format=sha1',
  'agent=makefun-forge/1.0',
];

/** v2 `fetch`: the client sends `want`/`have`/`shallow`/`deepen`/`done` lines. The server must send
 *  only what the client does not already hold — re-sending a held object is not merely wasteful, a
 *  strict client counts it as a protocol violation — and, when a depth was requested, must stop
 *  walking history at that depth instead of shipping the whole ancestry. */
function respondFetchV2(repo: Repo, args: string[], requestBody: Buffer): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth = 0;
  let done = false;
  let noProgress = false;

  for (const arg of args) {
    const line = arg.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || 0;
    else if (line === 'done') done = true;
    else if (line === 'no-progress') noProgress = true;
  }
  for (const raw of readPktLines(requestBody).map((entry) => entry.payload.toString('utf8'))) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || 0;
    else if (line === 'no-progress') noProgress = true;
    else if (line === 'done') done = true;
  }

  const held = new Set(haves);

  // Negotiation state, decided before the response is framed: `sendNow` says whether this reply
  // carries the packfile at all. Answering an acknowledgment without `ready` commits the exchange
  // to continue, so a pack sent in that same reply is rejected as an unfinished negotiation.
  const ackSection: Buffer[] = [];
  const shallowSection: Buffer[] = [];

  // A shallow clone is grafted at the commits exactly `depth` away from the wants. The boundary
  // commit is still sent; only its parent is withheld, and the boundary is announced here so the
  // client can graft the history and deepen it later.
  if (depth > 0) {
    const boundary = new Set<string>();
    const cut = (sha: string, remaining: number): void => {
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') return;
      if (remaining <= 1) {
        boundary.add(sha);
        return;
      }
      for (const parent of parseCommit(obj.data).parents) cut(parent, remaining - 1);
    };
    for (const want of wants) cut(want, depth);
    for (const sha of boundary) shallowSection.push(pkt(`shallow ${sha}\n`));
  }
  let sendNow = done || haves.length === 0;
  if (!done && haves.length > 0) {
    const known = haves.filter((have) => repo.objects.has(have));
    if (known.length > 0) {
      // One line, carrying the newest shared commit. A plain ACK followed by a second ACK with
      // `ready` is read as two separate acknowledgments, and the client rejects everything after
      // the first because it is not marked ready.
      ackSection.push(pkt(`ACK ${known[known.length - 1]} ready\n`));
      sendNow = true;
    } else {
      // Every `have` is unknown to us, but the wants are complete and the client sent no `done`.
      // Continuing the negotiation is wrong here — the client does not re-ask over stateless HTTP,
      // it just fails. Answering `ready` hands over the pack it asked for.
      ackSection.push(pkt(`ACK ${haves[haves.length - 1]} ready\n`));
      sendNow = true;
    }
  }

  // Objects to send: every object reachable from the wants, minus the ones the client already
  // holds. Two different limits apply and conflating them breaks shallow clones: `depth` bounds
  // how far back through COMMITS the history is sent, while trees and blobs belonging to a commit
  // that IS sent must always travel in full — a client that receives a commit without its tree
  // aborts with "bad tree object".
  const send: string[] = [];
  const seen = new Set<string>();
  const visitedCommits = new Set<string>();

  const walkTree = (sha: string): void => {
    if (seen.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (!obj) return;
    seen.add(sha);
    send.push(sha);
    if (obj.type === 'tree') for (const entry of parseTree(obj.data)) walkTree(entry.sha);
  };

  const walkCommit = (sha: string, commitBudget: number): void => {
    if (visitedCommits.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return;
    visitedCommits.add(sha);

    const record = parseCommit(obj.data);
    if (record.tree) walkTree(record.tree);
    if (!seen.has(sha) && !held.has(sha)) {
      seen.add(sha);
      send.push(sha);
    }

    // A commit at the depth boundary is sent, but its parents are not: that is exactly what makes
    // the clone shallow, and the boundary is announced in the shallow-info section.
    if (commitBudget > 1) for (const parent of record.parents) walkCommit(parent, commitBudget - 1);
  };

  const walkTag = (sha: string, commitBudget: number): void => {
    const obj = repo.objects.get(sha);
    if (!obj) return;
    if (seen.has(sha)) return;
    seen.add(sha);
    send.push(sha);
    const match = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    if (match) walkCommit(match[1], commitBudget);
  };

  const commitBudget = depth > 0 ? depth : Number.MAX_SAFE_INTEGER;
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'commit') walkCommit(want, commitBudget);
    else if (obj.type === 'tag') walkTag(want, commitBudget);
    else walkTree(want);
  }

  // Response layout, per the v2 fetch grammar. Sections are delimited by a `0001` pkt-line and
  // each carries its own header: acknowledgments, then shallow-info, then packfile. Merging
  // shallow-info into the acknowledgment section is what git reports as
  // "expected 'packfile', received 'shallow-info <sha>'".
  const body: Buffer[] = [];
  const sections: Buffer[][] = [];

  if (ackSection.length > 0) sections.push([pkt(`acknowledgments\n`), ...ackSection]);
  if (sendNow && shallowSection.length > 0) sections.push([pkt(`shallow-info\n`), ...shallowSection]);

  // Nothing is sent after an acknowledgment that is not `ready`: the client must keep negotiating,
  // so the reply ends here. Appending the pack makes git refuse the whole exchange.
  if (!sendNow) {
    // Every section is followed by a delimiter. Git closes the acknowledgments section only when it
  // sees one; without it the next header ("packfile") is read as another acknowledgment line.
  for (const section of sections) {
    body.push(...section);
    body.push(Buffer.from('0001', 'latin1'));
  }
    body.push(flush());
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
      body: Buffer.concat(body),
    };
  }

  // The delimiter only separates two sections that both exist. A trailing `0001` before the
  // packfile, with nothing between, is read as an extra empty section and the fetch is refused.
  // Every section is followed by a delimiter. Git closes the acknowledgments section only when it
  // sees one; without it the next header ("packfile") is read as another acknowledgment line.
  for (const section of sections) {
    body.push(...section);
    body.push(Buffer.from('0001', 'latin1'));
  }

  const packSection: Buffer[] = [pkt(`packfile\n`)];
  const pack = send.length === 0 ? emptyPack() : buildPackFor(repo, send, held);
  if (!noProgress && send.length > 0) {
    packSection.push(pktBin(Buffer.concat([Buffer.from([2]), Buffer.from(`Enumerating objects: ${send.length}, done.\n`)])));
  }
  for (const chunk of chunkBuffer(pack, 65515)) {
    packSection.push(pktBin(Buffer.concat([Buffer.from([1]), chunk])));
  }
  body.push(...packSection);
  body.push(flush());

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
    body: Buffer.concat(body),
  };
}

/** Split a payload into side-band sized chunks. The cap is 65515, not 65516: the four length bytes
 *  and the one band byte together must stay inside the 65520-byte pkt-line limit. */
function chunkBuffer(data: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    out.push(data.slice(offset, Math.min(offset + size, data.length)));
  }
  if (out.length === 0) out.push(Buffer.alloc(0));
  return out;
}

/** Raw (non-side-band) payload framed as pkt-lines, same chunking rule. */
function chunkToPkt(data: Buffer): Buffer[] {
  return chunkBuffer(data, 65515).map((chunk) => pktBin(chunk));
}

function emptyPack(): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0, 8);
  const checksum = createHash('sha1').update(header).digest();
  return Buffer.concat([header, checksum]);
}

// ---------------------------------------------------------------- protocol v2

// v2 is not a cosmetic upgrade of v0: the client sends its command as a pkt-line request body and
// expects a capability advertisement plus command-specific output. The rules require the server to
// honour `Git-Protocol: version=2` rather than silently answering v0 — a client told v0 negotiates
// differently and the difference shows up as re-sent objects and broken shallow clones.

const V2_CAPS = [
  'version 2',
  'agent=makefun-forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow',
  'server-option',
  'object-format=sha1',
];

/** The capability advertisement that precedes any v2 command response. */
function v2Capabilities(): Buffer {
  const lines = V2_CAPS.map((capability) => pkt(`${capability}\n`));
  lines.push(flush());
  return Buffer.concat(lines);
}

/** `ls-refs`: one pkt-line per ref, carrying only the attributes the client asked for. Git rejects
 *  the whole response if a returned ref does not match a requested `ref-prefix`, or if an attribute
 *  it did not request appears — so both the filter and the attribute set are honoured exactly. */
function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let symrefs = false;
  let peel = false;
  let unborn = false;

  for (const arg of args) {
    const line = arg.trim();
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'peel') peel = true;
    else if (line === 'unborn') unborn = true;
  }

  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: Buffer[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headSymref = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';

  // HEAD is reported like any other ref: it is filtered by the prefixes the client supplied, and
  // when the branch it points at does not exist yet it is the one case reported as `unborn`.
  if (matches('HEAD')) {
    // The order is sha first, then the ref name — the same as every other ref line. Sending
    // "HEAD <sha>" (name first) makes git reject the whole response as invalid, which is what a
    // clone reports as "invalid ls-refs response".
    if (headSha) lines.push(pkt(`${headSha} HEAD${headSymref}\n`));
    else if (unborn) lines.push(pkt(`unborn HEAD${headSymref}\n`));
  }

  for (const [name, sha] of Array.from(repo.refs.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!name.startsWith('refs/') || !matches(name)) continue;

    const obj = repo.objects.get(sha);
    if (peel && obj && obj.type === 'tag') {
      const peeled = peelTag(repo, sha);
      if (peeled) {
        lines.push(pkt(`${sha} ${name}\n`));
        lines.push(pkt(`${peeled} ${name}^{}\n`));
        continue;
      }
    }
    lines.push(pkt(`${sha} ${name}\n`));
  }
  lines.push(flush());
  return Buffer.concat(lines);
}

/** Walk a tag object down to the commit it names. */
function peelTag(repo: Repo, sha: string): string | null {
  let current = sha;
  for (let depth = 0; depth < 16; depth++) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type !== 'tag') return current;
    const text = obj.data.toString('utf8');
    const match = text.match(/^object ([0-9a-f]{40})$/m);
    if (!match) return null;
    current = match[1];
  }
  return null;
}

// ---------------------------------------------------------------- routes

function splitRepoPath(path: string): { owner: string; name: string; rest: string } | null {
  // /owner/repo.git/<rest>
  const withoutLeading = path.replace(/^\//, '');
  const gitIndex = withoutLeading.indexOf('.git');
  if (gitIndex < 0) return null;
  const before = withoutLeading.slice(0, gitIndex);
  const rest = withoutLeading.slice(gitIndex + 4).replace(/^\//, '');
  const slash = before.indexOf('/');
  if (slash <= 0) return null;
  return { owner: before.slice(0, slash), name: before.slice(slash + 1), rest };
}

export async function handleGitHttp(store: Store, request: GitRequest): Promise<GitResponse> {
  const parsed = splitRepoPath(request.path);
  if (!parsed) return { status: 404, body: 'Not Found' };

  const { owner, name, rest } = parsed;
  const repo = getRepo(store, owner, name);

  if (!request.authed) {
    return {
      status: 401,
      headers: {
        'content-type': 'text/plain',
        'www-authenticate': 'Basic realm="makefun"',
      },
      body: 'authentication required\n',
    };
  }

  if (!repo) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'repository not found\n' };
  if (repo.owner.toLowerCase() !== request.currentUser.toLowerCase()) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'repository not found\n' };
  }

  const gitProtocol = String(request.headers['git-protocol'] ?? request.headers['Git-Protocol'] ?? '');
  const wantsV2 = gitProtocol.split(':').some((part) => part.trim() === 'version=2');

  if (rest === 'info/refs' && request.method === 'GET') {
    const service = request.query.get('service');
    if (service === 'git-upload-pack') {
      if (wantsV2) {
        // v2 advertises capabilities once, with no refs: refs arrive through an `ls-refs` command,
        // which is what lets a client ask only for the prefixes it cares about.
        // v2 has no dummy section: the response is the capability list itself, terminated by a
        // flush. A leading "# service=" line (a v0 convention) makes git reject the advert.
        const lines = [v2Capabilities()];
        return {
          status: 200,
          headers: {
            'content-type': 'application/x-git-upload-pack-advertisement',
            'cache-control': 'no-cache',
            'git-protocol': 'version=2',
          },
          body: Buffer.concat(lines),
        };
      }
      const body = advertise(repo, 'git-upload-pack', UPLOAD_CAPS);
      return {
        status: 200,
        headers: {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'cache-control': 'no-cache',
        },
        body,
      };
    }
    if (service === 'git-receive-pack') {
      const body = advertise(repo, 'git-receive-pack', RECEIVE_CAPS);
      return {
        status: 200,
        headers: {
          'content-type': 'application/x-git-receive-pack-advertisement',
          'cache-control': 'no-cache',
        },
        body,
      };
    }
    // A plain GET of info/refs without a service is the dumb protocol: refuse it explicitly
    // rather than answering an empty body a client could mistake for success.
    return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'smart HTTP only\n' };
  }

  // v2 commands arrive as a pkt-line request: `command=<name>`, then argument lines, then a flush.
  if (rest === 'git-upload-pack' && request.method === 'POST' && wantsV2) {
    const lines = readPktLines(request.rawBody).map((entry) => entry.payload.toString('utf8'));
    const commandLine = lines.find((line) => line.startsWith('command='));
    if (!commandLine) {
      return { status: 400, headers: { 'content-type': 'text/plain' }, body: 'no command\n' };
    }
    const command = commandLine.slice('command='.length).trim();
    if (process.env.MAKEFUN_DEBUG_GIT) console.error('[v2]', command, JSON.stringify(lines));
    const args = lines.filter((line) => !line.startsWith('command=') && line.trim() !== '');

    if (command === 'ls-refs') {
      // Only the advert carries capabilities. An `ls-refs` reply is refs and a flush — repeating
      // the capability block here is what git rejects as "invalid ls-refs response".
      const body = lsRefs(repo, args);
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
        body,
      };
    }
    if (command === 'fetch') {
      try {
        return respondFetchV2(repo, args, request.rawBody);
      } catch (err) {
        console.error('[v2 fetch]', err instanceof Error ? err.stack : String(err));
        throw err;
      }
    }
    if (command === 'object-info') {
      const wants = args.filter((arg) => /^[0-9a-f]{40}$/.test(arg.trim())).map((arg) => arg.trim());
      const out: Buffer[] = [];
      for (const sha of wants) {
        const obj = repo.objects.get(sha);
        out.push(pkt(`${sha} ${obj ? obj.data.length : 0}\n`));
      }
      out.push(flush());
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
        body: Buffer.concat(out),
      };
    }
    return { status: 400, headers: { 'content-type': 'text/plain' }, body: `unknown command ${command}\n` };
  }

  if (rest === 'git-upload-pack' && request.method === 'POST') {
    return uploadPack(repo, request);
  }

  if (rest === 'git-receive-pack' && request.method === 'POST') {
    return receivePack(store, repo, request);
  }

  return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not Found' };
}

function uploadPack(repo: Repo, request: GitRequest): GitResponse {
  const lines = readPktLines(request.rawBody);
  const wants: string[] = [];
  const haves: string[] = [];
  let sideBand = false;
  let sideBandMax = 0;
  let noProgress = false;

  for (const line of lines) {
    if (line.flush) continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const sha = text.slice(5, 45);
      wants.push(sha);
      // Capabilities ride on the first want line.
      if (text.includes('side-band-64k')) sideBandMax = 65519;
      if (text.includes('side-band')) sideBand = true;
      if (text.includes('no-progress')) noProgress = true;
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5, 45));
    }
  }
  void noProgress;

  const haveSet = new Set<string>();
  for (const have of haves) {
    // Everything reachable from a have is already on the client.
    const seen = new Set<string>();
    const queue = [have];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      haveSet.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      const text = obj.data.toString('utf8');
      const head = text.split('\n\n')[0];
      for (const lineText of head.split('\n')) {
        if (lineText.startsWith('parent ')) queue.push(lineText.slice(7).trim());
        if (lineText.startsWith('tree ')) queue.push(lineText.slice(5).trim());
      }
      if (text.includes('\n\n')) {
        // The commit's tree is reachable; walk it below via the tree queue path.
      }
    }
  }
  // Walk the trees of every have commit too, so a clone that already has the files sends no blobs.
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (!obj || obj.type !== 'commit') continue;
    const treeMatch = obj.data.toString('utf8').match(/^tree ([0-9a-f]{40})$/m);
    if (treeMatch) collectTree(repo, treeMatch[1], haveSet);
  }

  const send: ScannedObject[] = [];
  const collected = new Set<string>();
  const collectCommit = (sha: string): void => {
    if (collected.has(sha)) return;
    collected.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) return;
    if (obj.type === 'commit') {
      const text = obj.data.toString('utf8');
      const treeMatch = text.match(/^tree ([0-9a-f]{40})$/m);
      const head = text.split('\n\n')[0];
      for (const line of head.split('\n')) {
        if (line.startsWith('parent ')) collectCommit(line.slice(7).trim());
      }
      if (treeMatch) collectTreeInto(repo, treeMatch[1], send, collected);
      send.push({ type: 'commit', data: obj.data, sha });
      return;
    }
    send.push({ type: obj.type, data: obj.data, sha });
  };

  for (const want of wants) {
    if (repo.objects.has(want)) collectCommit(want);
  }

  const missing = send.filter((obj) => !haveSet.has(obj.sha));

  // The client cannot read a pack until the negotiation closes, so the ACK/NAK exchange has to be
  // written before any pack byte: "NAK" when nothing it has is recognised, otherwise one ACK per
  // shared commit followed by the final ACK. Skipping it makes git fail with "expected ACK/NAK,
  // got 'PACK'" on a pack that is otherwise perfectly valid.
  const acknowledgement: string[] = [];
  const acknowledged = haves.filter((have) => repo.objects.has(have));
  for (const have of acknowledged) acknowledgement.push(`ACK ${have} common`);
  acknowledgement.push(acknowledged.length > 0 ? `ACK ${acknowledged[acknowledged.length - 1]} ready` : 'NAK');

  const pack = buildPack(missing);

  if (!sideBand && !sideBandMax) {
    const head = Buffer.concat(acknowledgement.map((line) => pkt(`${line}\n`)));
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
      body: Buffer.concat([head, pack]),
    };
  }

  // 65515, not the advertised 65519: the band byte and the four length bytes have to fit inside
  // the same 65520-byte pkt-line, and a chunk sized to the advertised max overflows it. The client
  // rejects the whole response with "pkt-line too long" rather than truncating.
  const max = sideBandMax > 0 ? 65515 : 999;
  const out: Buffer[] = [];
  // ACK/NAK travels as plain pkt-lines *outside* the side-band channel. Wrapping it in a channel
  // makes the client read the \x01 channel byte as the first character of "NAK" and abort with
  // "expected ACK/NAK" — the negotiation is a protocol layer below the data channel.
  for (const line of acknowledgement) out.push(pkt(`${line}\n`));
  for (let pos = 0; pos < pack.length; pos += max) {
    out.push(pktBin(Buffer.concat([Buffer.from([1]), pack.slice(pos, pos + max)])));
  }
  out.push(flush());

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
    body: Buffer.concat(out),
  };
}

function collectTree(repo: Repo, sha: string, into: Set<string>): void {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'tree') return;
  if (into.has(sha)) return;
  into.add(sha);
  const data = obj.data;
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.slice(pos, space).toString('latin1');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const child = data.slice(nul + 1, nul + 21).toString('hex');
    into.add(child);
    if (mode === '40000' || mode === '040000') collectTree(repo, child, into);
    pos = nul + 21;
  }
}

function collectTreeInto(repo: Repo, sha: string, out: ScannedObject[], collected: Set<string>): void {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'tree') return;
  if (collected.has(sha)) return;
  collected.add(sha);
  const data = obj.data;
  let pos = 0;
  const children: Array<{ mode: string; sha: string }> = [];
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.slice(pos, space).toString('latin1');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const child = data.slice(nul + 1, nul + 21).toString('hex');
    children.push({ mode, sha: child });
    pos = nul + 21;
  }
  // Subtrees first, then blobs, then this tree: git's own order keeps the client's index build
  // monotonic and matches what a real upload-pack emits.
  for (const child of children) {
    if (child.mode === '40000' || child.mode === '040000') collectTreeInto(repo, child.sha, out, collected);
  }
  for (const child of children) {
    if (child.mode === '40000' || child.mode === '040000') continue;
    if (collected.has(child.sha)) continue;
    const blob = repo.objects.get(child.sha);
    if (!blob) continue;
    collected.add(child.sha);
    out.push({ type: blob.type, data: blob.data, sha: child.sha });
  }
  out.push({ type: 'tree', data, sha });
}

function receivePack(store: Store, repo: Repo, request: GitRequest): GitResponse {
  const lines = readPktLines(request.rawBody);

  const updates: Array<{ oldSha: string; newSha: string; ref: string }> = [];
  const capabilities = new Set<string>();
  let sawCommands = false;
  let packStart = -1;

  // The command section is pkt-lines up to a flush; the packfile follows the flush, raw.
  let pos = 0;
  const data = request.rawBody;
  while (pos + 4 <= data.length) {
    const header = data.slice(pos, pos + 4).toString('latin1');
    const length = parseInt(header, 16);
    if (length === 0) {
      pos += 4;
      packStart = pos;
      break;
    }
    if (Number.isNaN(length) || length < 4) break;
    const payload = data.slice(pos + 4, pos + length);
    pos += length;
    const text = payload.toString('utf8').replace(/\n$/, '');
    if (text.length === 0) continue;

    if (!sawCommands) {
      // "<old> <new> <ref>\0caps"
      const nul = text.indexOf('\0');
      const commandPart = nul >= 0 ? text.slice(0, nul) : text;
      if (nul >= 0 && !sawCommands) {
        // The capability list rides only on the first command line, right after its NUL. Later
        // command lines carry an empty capability field, and re-adding from every line is how a
        // client that asked for report-status-v2 ends up answered with a v1 report.
        for (const cap of text.slice(nul + 1).split(' ')) {
          if (cap) capabilities.add(cap);
        }
      }
      const bits = commandPart.split(' ');
      if (bits.length >= 3) {
        updates.push({ oldSha: bits[0], newSha: bits[1], ref: bits[2] });
        sawCommands = true;
      }
      continue;
    }
    const bits = text.split(' ');
    if (bits.length >= 3) updates.push({ oldSha: bits[0], newSha: bits[1], ref: bits[2] });
  }
  void lines;

  const sideBand = capabilities.has('side-band-64k') || capabilities.has('side-band');
  const reportStatus = capabilities.has('report-status') || capabilities.has('report-status-v2');
  void store;

  const results: string[] = [];
  const shaLookup = (sha: string): ScannedObject | undefined => {
    const obj = repo.objects.get(sha);
    return obj ? { type: obj.type, data: obj.data, sha } : undefined;
  };

  if (packStart >= 0 && packStart < data.length) {
    const pack = data.slice(packStart);
    try {
      const objects = readPack(pack, repo, shaLookup);
      for (const obj of objects) {
        if (!repo.objects.has(obj.sha)) repo.objects.set(obj.sha, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: respondReceive(['unpack ' + `error ${message}`], sideBand, false),
      };
    }
  }

  for (const update of updates) {
    const zero = '0'.repeat(40);
    const current = repo.refs.get(update.ref);
    if (update.newSha === zero) {
      // A delete.
      if (!current) {
        results.push(`ng ${update.ref} not found`);
        continue;
      }
      repo.refs.delete(update.ref);
      results.push(`ok ${update.ref}`);
      continue;
    }
    if (!repo.objects.has(update.newSha)) {
      results.push(`ng ${update.ref} missing necessary objects`);
      continue;
    }
    // A non-fast-forward is refused the way a real server refuses it: the old sha the client
    // named must be the ref's current value, and the new commit must descend from it.
    if (update.oldSha !== zero && current && current !== update.oldSha) {
      results.push(`ng ${update.ref} remote ref changed since the client last fetched`);
      continue;
    }
    if (update.oldSha !== zero && current && !isDescendant(repo, current, update.newSha)) {
      results.push(`ng ${update.ref} non-fast-forward`);
      continue;
    }
    if (update.oldSha === zero && current) {
      results.push(`ng ${update.ref} already exists`);
      continue;
    }
    repo.refs.set(update.ref, update.newSha);
    // Every accepted update needs its own `ok <ref>` line. Updating the ref without reporting it
    // leaves the client waiting for a status that never arrives, so a push that actually landed
    // is reported to the user as a failure.
    results.push(`ok ${update.ref}`);
  }

  if (updates.length > 0) repo.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: respondReceive(results, sideBand, reportStatus),
  };
}

function isDescendant(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const head = obj.data.toString('utf8').split('\n\n')[0];
    for (const line of head.split('\n')) {
      if (line.startsWith('parent ')) {
        const parent = line.slice(7).trim();
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
  }
  return false;
}

function respondReceive(results: string[], sideBand: boolean, reportStatus: boolean): Buffer {
  const lines: string[] = [];
  const unpackOk = !results.some((r) => r.startsWith('unpack error'));
  if (reportStatus) {
    lines.push(unpackOk ? 'unpack ok' : 'unpack error');
    for (const result of results) lines.push(result);
  }

  // The report body is itself a pkt-line stream, so it has to end with its own flush before the
  // side-band channel closes; without the inner flush the client reads the channel terminator as
  // a truncated report and aborts a push that already succeeded. Only a report ends with a flush
  // — an empty response to a client that asked for no report is just the outer one.
  const report = reportStatus ? Buffer.concat([Buffer.concat(lines.map((line) => pkt(`${line}\n`))), flush()]) : Buffer.alloc(0);

  if (!sideBand) {
    return reportStatus ? report : flush();
  }

  const out: Buffer[] = [];
  for (let pos = 0; pos < report.length; pos += 65515) {
    const slice = report.slice(pos, pos + 65515);
    const chunk = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktRaw(chunk));
  }
  out.push(flush());
  return Buffer.concat(out);
}

/** Wrap already-assembled bytes in a pkt-line header without re-encoding them as a string. */
function pktRaw(payload: Buffer): Buffer {
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([header, payload]);
}
