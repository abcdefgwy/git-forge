export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function decodeTag(data: Buffer): ParsedTag {
  const sep = data.indexOf('\n\n');
  const hdrText = (sep < 0 ? data : data.subarray(0, sep)).toString('utf8');
  const message = sep < 0 ? '' : data.subarray(sep + 2).toString('utf8');
  let object = '';
  let type = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of hdrText.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'object') object = v.trim();
    else if (k === 'type') type = v.trim();
    else if (k === 'tag') tag = v;
    else if (k === 'tagger') tagger = v;
  }
  return { object, type, tag, tagger, message };
}

/**
 * 高性能内存 Git 对象库、Packfile 编解码器与 Smart HTTP v0/v2 协议引擎 (v2.1.0)
 *
 * 完整支持：
 * - Git SHA-1 对象模型 (blob / tree / commit / tag)
 * - Packfile v2 解析与 OFS_DELTA / REF_DELTA 链式还原
 * - Packfile v2 生成（非 delta 对象零解压直拷、低开销压缩）
 * - Smart HTTP v0 & v2（info/refs、ls-refs、fetch、deepen 1 浅克隆、receive-pack 推送）
 * - 全协议 HTTP/1.1 完整响应帧缓存（v2 + v0 + push fast-path）
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  buildHttpFrame,
  GIT_RECEIVE_ADV_CT,
  GIT_RECEIVE_RES_CT,
  GIT_UPLOAD_ADV_CT,
  GIT_UPLOAD_RES_CT,
} from './http-frame.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  oid: string;
  type: GitObjectType;
  data: Buffer;
  /** 缓存已打好 pack 头部与 zlib 压缩体的二进制切片，大幅加速重复 clone */
  packEntryBuf: Buffer | null;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface ChangedFileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  sha: string;
  additions: number;
  deletions: number;
  changes: number;
}

const TYPE_TO_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const ZERO_SHA = '0000000000000000000000000000000000000000';
const PACK_SIG = Buffer.from('PACK');
const FLUSH_PKT = Buffer.from('0000', 'ascii');
const DELIM_PKT = Buffer.from('0001', 'ascii');

export function isHex40(s: string): boolean {
  if (s.length !== 40) return false;
  for (let i = 0; i < 40; i++) {
    const c = s.charCodeAt(i);
    const isHex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!isHex) return false;
  }
  return true;
}

export function computeGitOid(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'ascii').update(data).digest('hex');
}

/** 构造单条 Git pkt-line（4 位十六进制长度前缀） */
export function pktLine(payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const totalLen = buf.length + 4;
  const out = Buffer.allocUnsafe(totalLen);
  out.write(totalLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  buf.copy(out, 4);
  return out;
}

/** 构造带 sideband channel byte (1=pack, 2=progress, 3=error) 的 pkt-line */
export function pktSideband(channel: 1 | 2 | 3, payload: Buffer | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const totalLen = buf.length + 5;
  const out = Buffer.allocUnsafe(totalLen);
  out.write(totalLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  out[4] = channel;
  buf.copy(out, 5);
  return out;
}

/** 批量拼接多条 pkt-line + 可选 flush */
export function pktSequence(lines: Array<Buffer | string>, withFlush = true): Buffer {
  const parts: Buffer[] = lines.map((l) => pktLine(l));
  if (withFlush) parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** 将大块 packfile 切分为符合 pkt-line 65515 字节上限的 side-band-64k 包 */
function wrapSidebandBand1(pack: Buffer): Buffer {
  const MAX_CHUNK = 65500;
  if (pack.length <= MAX_CHUNK) {
    const totalLen = pack.length + 5;
    const out = Buffer.allocUnsafe(totalLen + 4);
    out.write(totalLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    out[4] = 1;
    pack.copy(out, 5);
    out.write('0000', totalLen, 4, 'ascii');
    return out;
  }
  const chunks: Buffer[] = [];
  for (let off = 0; off < pack.length; off += MAX_CHUNK) {
    const end = Math.min(off + MAX_CHUNK, pack.length);
    chunks.push(pktSideband(1, pack.subarray(off, end)));
  }
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

/** 编码 Packfile 变长对象头 (type + uncompressedSize) */
function encodePackObjHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = ((typeCode & 0x07) << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let b = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

function getObjectPackChunk(obj: GitObject): Buffer {
  if (obj.packEntryBuf === null) {
    const hdr = encodePackObjHeader(TYPE_TO_CODE[obj.type], obj.data.length);
    const compressed = deflateSync(obj.data, { level: 1 });
    obj.packEntryBuf = Buffer.concat([hdr, compressed]);
  }
  return obj.packEntryBuf;
}

/** 将若干 Git 对象直接拼装为带 20 字节 SHA-1 校验尾的 Packfile v2 */
export function assemblePackFromStored(objects: GitObject[]): Buffer {
  const count = objects.length;
  let totalBodyBytes = 12;
  const chunks: Buffer[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const c = getObjectPackChunk(objects[i]!);
    chunks[i] = c;
    totalBodyBytes += c.length;
  }
  const out = Buffer.allocUnsafe(totalBodyBytes + 20);
  out.write('PACK', 0, 4, 'ascii');
  out.writeUInt32BE(2, 4);
  out.writeUInt32BE(count, 8);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const c = chunks[i]!;
    c.copy(out, pos);
    pos += c.length;
  }
  const digest = createHash('sha1').update(out.subarray(0, totalBodyBytes)).digest();
  digest.copy(out, totalBodyBytes);
  return out;
}

/** 解析 Git Tree 二进制内容 */
export function decodeTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const mode = data.subarray(offset, spaceIdx).toString('ascii');
    const nulIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nulIdx === -1 || nulIdx + 21 > data.length) break;
    const name = data.subarray(spaceIdx + 1, nulIdx).toString('utf8');
    const oid = data.subarray(nulIdx + 1, nulIdx + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nulIdx + 21;
  }
  return entries;
}

/** 按 Git 规范（目录名末尾视同加 '/'）排序并编码 Tree 对象 */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ak = a.mode === '40000' ? `${a.name}/` : a.name;
    const bk = b.mode === '40000' ? `${b.name}/` : b.name;
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const normalizedMode = e.mode === '040000' ? '40000' : e.mode;
    parts.push(Buffer.from(`${normalizedMode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** 解析 Git Commit 对象 */
export function decodeCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerBlock = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);

  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of headerBlock.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim());
    } else if (line.startsWith('author ')) {
      author = line.slice(7);
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
    }
  }
  return { tree, parents, author, committer, message };
}

/** 编码 Git Commit 对象 */
export function encodeCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  authorName?: string;
  authorEmail?: string;
  timestampSec?: number;
}): Buffer {
  const ts = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const name = opts.authorName ?? 'ada iversen';
  const email = opts.authorEmail ?? 'adaiversen@example.invalid';
  const ident = `${name} <${email}> ${ts} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) {
    lines.push(`parent ${p}`);
  }
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  const msg = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

/**
 * 解析 Git delta 指令并应用到基对象上，输出目标对象内容
 */
function applyGitDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let val = 0;
    let shift = 0;
    while (pos < delta.length) {
      const b = delta[pos++]!;
      val |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return val;
  };

  const baseSize = readVarint();
  const targetSize = readVarint();
  if (base.length !== baseSize) {
    throw new Error(`Delta base size mismatch: expected ${baseSize}, got ${base.length}`);
  }

  const out = Buffer.allocUnsafe(targetSize);
  let outPos = 0;

  while (pos < delta.length) {
    const cmd = delta[pos++]!;
    if ((cmd & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((cmd & 0x01) !== 0) copyOffset |= delta[pos++]!;
      if ((cmd & 0x02) !== 0) copyOffset |= delta[pos++]! << 8;
      if ((cmd & 0x04) !== 0) copyOffset |= delta[pos++]! << 16;
      if ((cmd & 0x08) !== 0) copyOffset |= delta[pos++]! << 24;
      if ((cmd & 0x10) !== 0) copySize |= delta[pos++]!;
      if ((cmd & 0x20) !== 0) copySize |= delta[pos++]! << 8;
      if ((cmd & 0x40) !== 0) copySize |= delta[pos++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, outPos, copyOffset, copyOffset + copySize);
      outPos += copySize;
    } else if (cmd > 0) {
      delta.copy(out, outPos, pos, pos + cmd);
      pos += cmd;
      outPos += cmd;
    } else {
      throw new Error('Reserved delta opcode 0x00');
    }
  }
  if (outPos !== targetSize) {
    throw new Error(`Delta target size mismatch: expected ${targetSize}, got ${outPos}`);
  }
  return out;
}

interface ParsedPktRequest {
  lines: string[];
  trailingRaw: Buffer;
}

/** 零分配解析 4 字节 ASCII 十六进制长度，非法时返回 -1 */
function parseHex4(buf: Buffer, offset: number): number {
  let val = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[offset + i]!;
    let nibble: number;
    if (c >= 48 && c <= 57) nibble = c - 48;
    else if (c >= 97 && c <= 102) nibble = c - 87;
    else if (c >= 65 && c <= 70) nibble = c - 55;
    else return -1;
    val = (val << 4) | nibble;
  }
  return val;
}

/** 解析客户端发来的 pkt-line 序列，可选保留后面的裸 packfile 数据 */
function decodeRequestPktStream(buf: Buffer, stopAfterFirstFlush = false): ParsedPktRequest {
  const lines: string[] = [];
  let offset = 0;

  while (offset + 4 <= buf.length) {
    const len = parseHex4(buf, offset);
    if (len < 0) break;
    offset += 4;
    if (len === 0) {
      lines.push('__FLUSH__');
      if (stopAfterFirstFlush) {
        return { lines, trailingRaw: buf.subarray(offset) };
      }
      continue;
    }
    if (len === 1) {
      lines.push('__DELIM__');
      continue;
    }
    if (len === 2) {
      lines.push('__RESPONSE_END__');
      continue;
    }
    if (len < 4 || offset + (len - 4) > buf.length) {
      offset -= 4;
      break;
    }
    const payloadLen = len - 4;
    const rawLine = buf.subarray(offset, offset + payloadLen).toString('utf8');
    lines.push(rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine);
    offset += payloadLen;
  }
  return { lines, trailingRaw: buf.subarray(offset) };
}

/** 预编译好的 Protocol v2 upload-pack 能力通告 */
export const V2_UPLOAD_ADVERTISEMENT_BUF = pktSequence(
  [
    '# service=git-upload-pack\n',
    '__FLUSH_SENTINEL__',
  ].slice(0, 1),
  false,
);

const V2_ADV_COMBINED = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  FLUSH_PKT,
  pktLine('version 2\n'),
  pktLine('agent=git/makefun-forge-1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  FLUSH_PKT,
]);

export const V2_UPLOAD_ADV_HTTP_FRAME = buildHttpFrame(
  200,
  GIT_UPLOAD_ADV_CT,
  V2_ADV_COMBINED,
  'Cache-Control: no-cache\r\n',
);

const STATIC_PUSH_MAIN_SIDEBAND_OK_BUF = Buffer.concat([
  pktSideband(1, Buffer.concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), FLUSH_PKT])),
  FLUSH_PKT,
]);

const STATIC_PUSH_MAIN_RAW_OK_BUF = Buffer.concat([
  pktLine('unpack ok\n'),
  pktLine('ok refs/heads/main\n'),
  FLUSH_PKT,
]);

export const STATIC_PUSH_MAIN_SIDEBAND_OK_HTTP_FRAME = buildHttpFrame(
  200,
  GIT_RECEIVE_RES_CT,
  STATIC_PUSH_MAIN_SIDEBAND_OK_BUF,
  'Cache-Control: no-cache\r\n',
);

export const STATIC_PUSH_MAIN_RAW_OK_HTTP_FRAME = buildHttpFrame(
  200,
  GIT_RECEIVE_RES_CT,
  STATIC_PUSH_MAIN_RAW_OK_BUF,
  'Cache-Control: no-cache\r\n',
);

export function getStaticV2UploadAdvertisement(): Buffer {
  return V2_ADV_COMBINED;
}

/**
 * 单个 Git 仓库实例（对象库 + Refs + 协议处理）
 */
export class GitRepositoryStore {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  defaultBranch = 'main';
  version = 0;

  /** 缓存的响应 Buffer 与完整 HTTP/1.1 响应帧，在 bumpVersion 时统一失效 */
  cachedReceiveAdvBuf: Buffer | null = null;
  cachedReceiveAdvHttpFrame: Buffer | null = null;
  cachedUploadAdvV0Buf: Buffer | null = null;
  cachedUploadAdvV0HttpFrame: Buffer | null = null;
  cachedV2LsRefs = new Map<string, Buffer>();
  cachedV2Fetch = new Map<string, Buffer>();
  cachedV2RawBody = new Map<string, Buffer>();
  cachedV2RawBodyHttpFrame = new Map<string, Buffer>();
  cachedV0RawBodyHttpFrame = new Map<string, Buffer>();
  cachedV0FetchHttpFrame = new Map<string, Buffer>();

  bumpVersion(): void {
    this.version++;
    this.cachedReceiveAdvBuf = null;
    this.cachedReceiveAdvHttpFrame = null;
    this.cachedUploadAdvV0Buf = null;
    this.cachedUploadAdvV0HttpFrame = null;
    this.cachedV2LsRefs.clear();
    this.cachedV2Fetch.clear();
    this.cachedV2RawBody.clear();
    this.cachedV2RawBodyHttpFrame.clear();
    this.cachedV0RawBodyHttpFrame.clear();
    this.cachedV0FetchHttpFrame.clear();
  }

  putObject(type: GitObjectType, data: Buffer, prebuiltPackSlice: Buffer | null = null): GitObject {
    const oid = computeGitOid(type, data);
    const existing = this.objects.get(oid);
    if (existing) {
      if (existing.packEntryBuf === null && prebuiltPackSlice !== null) {
        existing.packEntryBuf = prebuiltPackSlice;
      }
      return existing;
    }
    const obj: GitObject = {
      oid,
      type,
      data,
      packEntryBuf: prebuiltPackSlice,
    };
    this.objects.set(oid, obj);
    return obj;
  }

  /** 读取并解析 Commit 对象 */
  getCommit(oid: string): ParsedCommit | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return decodeCommit(obj.data);
  }

  /** 剥离 Annotated Tag（若有）返回最终指向的对象 OID */
    getTag(oid: string): ParsedTag | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'tag') return null;
    return decodeTag(obj.data);
  }

  peelTag(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 8; i++) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (!m) return cur;
      cur = m[1]!;
    }
    return cur;
  }

  /** 读取并解析 Tree 对象 */
  getTree(oid: string): TreeEntry[] | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    return decodeTree(obj.data);
  }

  /** 递归展开 Tree 为 `path -> blobOid` 平面映射 */
  flattenTree(treeOid: string | null, prefix = '', out = new Map<string, string>()): Map<string, string> {
    if (!treeOid) return out;
    const entries = this.getTree(treeOid);
    if (!entries) return out;
    for (const e of entries) {
      const fullPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        this.flattenTree(e.oid, fullPath, out);
      } else {
        out.set(fullPath, e.oid);
      }
    }
    return out;
  }

  /** 从 `path -> blobOid` 平面映射递归生成嵌套 Tree 对象并返回根 Tree OID */
  buildTreeFromMap(files: Map<string, string>): string {
    interface DirNode {
      blobs: Array<{ name: string; oid: string }>;
      dirs: Map<string, DirNode>;
    }
    const makeDir = (): DirNode => ({ blobs: [], dirs: new Map() });
    const root = makeDir();

    for (const [filePath, oid] of files.entries()) {
      const clean = filePath.replace(/^\/+|\/+$/g, '');
      if (!clean) continue;
      const parts = clean.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        let child = cur.dirs.get(seg);
        if (!child) {
          child = makeDir();
          cur.dirs.set(seg, child);
        }
        cur = child;
      }
      cur.blobs.push({ name: parts[parts.length - 1]!, oid });
    }

    const writeNode = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const b of node.blobs) {
        entries.push({ mode: '100644', name: b.name, oid: b.oid });
      }
      for (const [dName, dNode] of node.dirs.entries()) {
        const subOid = writeNode(dNode);
        entries.push({ mode: '40000', name: dName, oid: subOid });
      }
      const treeBuf = encodeTree(entries);
      return this.putObject('tree', treeBuf).oid;
    };

    return writeNode(root);
  }

  /** 判断 `ancestorOid` 是否为 `descendantOid` 的祖先提交 */
  isAncestor(ancestorOid: string, descendantOid: string): boolean {
    if (ancestorOid === descendantOid) return true;
    const direct = this.getCommit(descendantOid);
    if (direct && direct.parents.includes(ancestorOid)) return true;

    const visited = new Set<string>();
    const queue = [descendantOid];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === ancestorOid) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const parsed = this.getCommit(cur);
      if (!parsed) continue;
      for (const p of parsed.parents) {
        if (p === ancestorOid) return true;
        if (!visited.has(p)) queue.push(p);
      }
    }
    return false;
  }

  /** 查找两个 commit 最近的共同祖先 (LCA) */
  findMergeBase(commitA: string, commitB: string): string | null {
    const ancestorsA = new Set<string>();
    const qA = [commitA];
    while (qA.length > 0) {
      const c = qA.shift()!;
      if (ancestorsA.has(c)) continue;
      ancestorsA.add(c);
      const parsed = this.getCommit(c);
      if (parsed) qA.push(...parsed.parents);
    }

    const visitedB = new Set<string>();
    const qB = [commitB];
    while (qB.length > 0) {
      const c = qB.shift()!;
      if (ancestorsA.has(c)) return c;
      if (visitedB.has(c)) continue;
      visitedB.add(c);
      const parsed = this.getCommit(c);
      if (parsed) qB.push(...parsed.parents);
    }
    return null;
  }

  /** 三路合并：若无冲突返回合并后的新 Tree OID，存在冲突返回 null */
  threeWayMergeTrees(baseCommitOid: string, headCommitOid: string): string | null {
    const baseCommit = this.getCommit(baseCommitOid);
    const headCommit = this.getCommit(headCommitOid);
    if (!baseCommit || !headCommit) return null;

    const lcaOid = this.findMergeBase(baseCommitOid, headCommitOid);
    const lcaTree = lcaOid ? (this.getCommit(lcaOid)?.tree ?? null) : null;

    const lcaFiles = this.flattenTree(lcaTree);
    const baseFiles = this.flattenTree(baseCommit.tree);
    const headFiles = this.flattenTree(headCommit.tree);

    const allPaths = new Set<string>([...lcaFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    const merged = new Map<string, string>();

    for (const p of allPaths) {
      const o = lcaFiles.get(p);
      const a = baseFiles.get(p);
      const b = headFiles.get(p);

      if (a === b) {
        if (a !== undefined) merged.set(p, a);
      } else if (a === o) {
        if (b !== undefined) merged.set(p, b);
      } else if (b === o) {
        if (a !== undefined) merged.set(p, a);
      } else {
        return null;
      }
    }
    return this.buildTreeFromMap(merged);
  }

  /** 计算从 baseCommit 到 headCommit 的文件变更列表 */
  diffCommits(baseCommitOid: string, headCommitOid: string): ChangedFileDiff[] {
    const baseCommit = this.getCommit(baseCommitOid);
    const headCommit = this.getCommit(headCommitOid);
    const baseFiles = this.flattenTree(baseCommit?.tree ?? null);
    const headFiles = this.flattenTree(headCommit?.tree ?? null);

    const allPaths = [...new Set<string>([...baseFiles.keys(), ...headFiles.keys()])].sort();
    const diffs: ChangedFileDiff[] = [];

    for (const filename of allPaths) {
      const oldOid = baseFiles.get(filename);
      const newOid = headFiles.get(filename);
      if (oldOid === newOid) continue;

      const countLines = (oid?: string): number => {
        if (!oid) return 0;
        const text = this.objects.get(oid)?.data.toString('utf8') ?? '';
        if (text.length === 0) return 0;
        return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
      };

      if (!oldOid && newOid) {
        const adds = Math.max(1, countLines(newOid));
        diffs.push({ filename, status: 'added', sha: newOid, additions: adds, deletions: 0, changes: adds });
      } else if (oldOid && !newOid) {
        const dels = Math.max(1, countLines(oldOid));
        diffs.push({ filename, status: 'removed', sha: oldOid, additions: 0, deletions: dels, changes: dels });
      } else if (oldOid && newOid) {
        const oldLines = (this.objects.get(oldOid)?.data.toString('utf8') ?? '').split('\n');
        const newLines = (this.objects.get(newOid)?.data.toString('utf8') ?? '').split('\n');
        const oldSet = new Set(oldLines);
        const newSet = new Set(newLines);
        let adds = 0;
        let dels = 0;
        for (const l of newLines) if (!oldSet.has(l)) adds++;
        for (const l of oldLines) if (!newSet.has(l)) dels++;
        if (adds === 0 && dels === 0) adds = 1;
        diffs.push({
          filename,
          status: 'modified',
          sha: newOid,
          additions: adds,
          deletions: dels,
          changes: adds + dels,
        });
      }
    }
    return diffs;
  }

  /** 收集仅在 head 不在 stopAt 祖先链上的 commit（按拓扑从旧到新排列） */
  collectExclusiveHistory(headOid: string, stopAtOid: string | null): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const dfs = (oid: string): void => {
      if (visited.has(oid) || oid === stopAtOid) return;
      visited.add(oid);
      const parsed = this.getCommit(oid);
      if (!parsed) return;
      if (parsed.parents[0]) {
        dfs(parsed.parents[0]);
      }
      result.push(oid);
    };
    dfs(headOid);
    return result;
  }

  /** 解析客户端推送的 Packfile v2 并原子性写入本地对象库 */
  unpackPackfile(pack: Buffer): void {
    if (pack.length < 32) {
      throw new Error('Packfile too short');
    }
    if (!pack.subarray(0, 4).equals(PACK_SIG)) {
      throw new Error('Invalid PACK signature');
    }
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) {
      throw new Error(`Unsupported pack version ${version}`);
    }
    const numObjects = pack.readUInt32BE(8);
    const bodyEnd = pack.length - 20;

    // 零字符串分配校验 pack 尾部 20 字节 SHA-1
    const actualDigest = createHash('sha1').update(pack.subarray(0, bodyEnd)).digest();
    if (!actualDigest.equals(pack.subarray(bodyEnd))) {
      throw new Error('Packfile checksum mismatch');
    }

    interface PendingEntry {
      offset: number;
      typeCode: number;
      baseOffset?: number;
      baseOid?: string;
      data: Buffer;
      rawNonDeltaSlice: Buffer | null;
      resolvedType?: GitObjectType;
      resolvedData?: Buffer;
    }

    const entries: PendingEntry[] = new Array(numObjects);
    let hasOfsDelta = false;
    let hasRefDelta = false;
    let offset = 12;

    for (let i = 0; i < numObjects; i++) {
      const entryStart = offset;
      const first = pack[offset++]!;
      const typeCode = (first >> 4) & 0x07;
      let declaredSize = first & 0x0f;
      let shift = 4;
      let cur = first;
      while ((cur & 0x80) !== 0) {
        cur = pack[offset++]!;
        declaredSize += (cur & 0x7f) * 2 ** shift;
        shift += 7;
      }

      let baseOffset: number | undefined;
      let baseOid: string | undefined;

      if (typeCode === 6) {
        hasOfsDelta = true;
        let b = pack[offset++]!;
        let negOff = b & 0x7f;
        while ((b & 0x80) !== 0) {
          b = pack[offset++]!;
          negOff = ((negOff + 1) << 7) | (b & 0x7f);
        }
        baseOffset = entryStart - negOff;
      } else if (typeCode === 7) {
        hasRefDelta = true;
        baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      }

      const chunkSize = Math.max(128, Math.min(16384, declaredSize + 16));
      const inf = inflateSync(pack.subarray(offset, bodyEnd), {
        info: true,
        chunkSize,
      }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      if (inf.buffer.length !== declaredSize) {
        throw new Error(`Inflated size mismatch: expected ${declaredSize}, got ${inf.buffer.length}`);
      }
      const nextOffset = offset + inf.engine.bytesWritten;
      const rawNonDeltaSlice = typeCode >= 1 && typeCode <= 4 ? pack.subarray(entryStart, nextOffset) : null;
      offset = nextOffset;

      entries[i] = {
        offset: entryStart,
        typeCode,
        baseOffset,
        baseOid,
        data: inf.buffer,
        rawNonDeltaSlice,
      };
    }

    // 快速无 delta 直通路径：跳过 Map 构建与递归解析
    if (!hasOfsDelta && !hasRefDelta) {
      for (let i = 0; i < numObjects; i++) {
        const e = entries[i]!;
        const type = CODE_TO_TYPE[e.typeCode];
        if (!type) throw new Error(`Unknown pack object type code: ${e.typeCode}`);
        this.putObject(type, e.data, e.rawNonDeltaSlice);
      }
      return;
    }

    const byOffset = hasOfsDelta ? new Map<number, PendingEntry>() : null;
    if (byOffset) {
      for (const e of entries) byOffset.set(e.offset, e);
    }

    const byOid = hasRefDelta ? new Map<string, PendingEntry>() : null;
    if (byOid) {
      for (const e of entries) {
        if (e.typeCode >= 1 && e.typeCode <= 4) {
          const type = CODE_TO_TYPE[e.typeCode]!;
          e.resolvedType = type;
          e.resolvedData = e.data;
          const stored = this.putObject(type, e.data, e.rawNonDeltaSlice);
          byOid.set(stored.oid, e);
        }
      }
    }

    const resolveEntry = (entry: PendingEntry): { type: GitObjectType; data: Buffer } => {
      if (entry.resolvedType && entry.resolvedData) {
        return { type: entry.resolvedType, data: entry.resolvedData };
      }

      if (entry.typeCode >= 1 && entry.typeCode <= 4) {
        const type = CODE_TO_TYPE[entry.typeCode]!;
        entry.resolvedType = type;
        entry.resolvedData = entry.data;
        const stored = this.putObject(type, entry.data, entry.rawNonDeltaSlice);
        byOid?.set(stored.oid, entry);
        return { type, data: entry.data };
      }

      let baseType: GitObjectType;
      let baseData: Buffer;

      if (entry.typeCode === 6) {
        const baseEntry = byOffset?.get(entry.baseOffset!);
        if (!baseEntry) throw new Error(`Missing OFS_DELTA base at offset ${entry.baseOffset}`);
        const resolved = resolveEntry(baseEntry);
        baseType = resolved.type;
        baseData = resolved.data;
      } else if (entry.typeCode === 7) {
        const existing = this.objects.get(entry.baseOid!);
        if (existing) {
          baseType = existing.type;
          baseData = existing.data;
        } else {
          const baseEntry = byOid?.get(entry.baseOid!);
          if (!baseEntry) throw new Error(`Missing REF_DELTA base ${entry.baseOid}`);
          const resolved = resolveEntry(baseEntry);
          baseType = resolved.type;
          baseData = resolved.data;
        }
      } else {
        throw new Error(`Unknown pack object type code: ${entry.typeCode}`);
      }

      const finalData = applyGitDelta(baseData, entry.data);
      entry.resolvedType = baseType;
      entry.resolvedData = finalData;
      const stored = this.putObject(baseType, finalData, null);
      byOid?.set(stored.oid, entry);
      return { type: baseType, data: finalData };
    };

    for (const entry of entries) {
      resolveEntry(entry);
    }
  }

  /** 构建 Smart HTTP v0 upload-pack refs 列表 */
  buildUploadPackAdvV0(): Buffer {
    if (this.cachedUploadAdvV0Buf) return this.cachedUploadAdvV0Buf;

    const caps = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow agent=git/makefun-forge-1.0';
    const sortedRefs = [...this.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const lines: string[] = ['# service=git-upload-pack\n'];
    const headTarget = `refs/heads/${this.defaultBranch}`;
    const headOid = this.refs.get(headTarget);
    const symrefCap = ` symref=HEAD:${headTarget}`;

    const chunks: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH_PKT];

    if (sortedRefs.length === 0) {
      chunks.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}${symrefCap}\n`));
    } else {
      let sentCaps = false;
      if (headOid) {
        chunks.push(pktLine(`${headOid} HEAD\0${caps}${symrefCap}\n`));
        sentCaps = true;
      }
      for (const [refName, oid] of sortedRefs) {
        if (!sentCaps) {
          chunks.push(pktLine(`${oid} ${refName}\0${caps}${symrefCap}\n`));
          sentCaps = true;
        } else {
          chunks.push(pktLine(`${oid} ${refName}\n`));
        }
      }
    }
    void lines;
    chunks.push(FLUSH_PKT);
    const out = Buffer.concat(chunks);
    this.cachedUploadAdvV0Buf = out;
    return out;
  }

  buildUploadPackAdvV0HttpFrame(): Buffer {
    if (this.cachedUploadAdvV0HttpFrame) return this.cachedUploadAdvV0HttpFrame;
    const frame = buildHttpFrame(
      200,
      GIT_UPLOAD_ADV_CT,
      this.buildUploadPackAdvV0(),
      'Cache-Control: no-cache\r\n',
    );
    this.cachedUploadAdvV0HttpFrame = frame;
    return frame;
  }

  /** 构建 Smart HTTP receive-pack refs 列表 */
  buildReceivePackAdv(): Buffer {
    if (this.cachedReceiveAdvBuf) return this.cachedReceiveAdvBuf;

    const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta atomic agent=git/makefun-forge-1.0';
    const sortedRefs = [...this.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const chunks: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH_PKT];

    if (sortedRefs.length === 0) {
      chunks.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
    } else {
      for (let i = 0; i < sortedRefs.length; i++) {
        const [refName, oid] = sortedRefs[i]!;
        if (i === 0) {
          chunks.push(pktLine(`${oid} ${refName}\0${caps}\n`));
        } else {
          chunks.push(pktLine(`${oid} ${refName}\n`));
        }
      }
    }
    chunks.push(FLUSH_PKT);
    const out = Buffer.concat(chunks);
    this.cachedReceiveAdvBuf = out;
    return out;
  }

  buildReceivePackAdvHttpFrame(): Buffer {
    if (this.cachedReceiveAdvHttpFrame) return this.cachedReceiveAdvHttpFrame;
    const frame = buildHttpFrame(
      200,
      GIT_RECEIVE_ADV_CT,
      this.buildReceivePackAdv(),
      'Cache-Control: no-cache\r\n',
    );
    this.cachedReceiveAdvHttpFrame = frame;
    return frame;
  }

  /** 处理 Git Smart HTTP 请求入口（支持 v2 与 v0，内置完整 HTTP 帧缓存） */
  handleUploadPackHttpFrame(rawBody: Buffer, wantsV2: boolean): Buffer {
    const rawKey = rawBody.length <= 4096 ? rawBody.toString('latin1') : null;
    if (wantsV2) {
      if (rawKey !== null) {
        const hit = this.cachedV2RawBodyHttpFrame.get(rawKey);
        if (hit) return hit;
      }
      const out = this.handleUploadPack(rawBody, true);
      const frame = buildHttpFrame(200, GIT_UPLOAD_RES_CT, out, 'Cache-Control: no-cache\r\n');
      if (rawKey !== null && this.cachedV2RawBodyHttpFrame.size < 32) {
        this.cachedV2RawBodyHttpFrame.set(rawKey, frame);
      }
      return frame;
    }

    if (rawKey !== null) {
      const hit = this.cachedV0RawBodyHttpFrame.get(rawKey);
      if (hit) return hit;
    }
    const out = this.handleUploadPack(rawBody, false);
    const frame = buildHttpFrame(200, GIT_UPLOAD_RES_CT, out, 'Cache-Control: no-cache\r\n');
    if (rawKey !== null && this.cachedV0RawBodyHttpFrame.size < 32) {
      this.cachedV0RawBodyHttpFrame.set(rawKey, frame);
    }
    return frame;
  }

  handleUploadPack(rawBody: Buffer, wantsV2: boolean): Buffer {
    const { lines } = decodeRequestPktStream(rawBody, false);
    if (wantsV2) {
      let command = '';
      for (const l of lines) {
        if (l.startsWith('command=')) {
          command = l.slice(8).trim();
          break;
        }
      }
      if (command === 'ls-refs') {
        const cacheKey = rawBody.length <= 512 ? rawBody.toString('latin1') : null;
        if (cacheKey !== null) {
          const hit = this.cachedV2LsRefs.get(cacheKey);
          if (hit) return hit;
        }
        const out = this.handleV2LsRefs(lines);
        if (cacheKey !== null && this.cachedV2LsRefs.size < 16) {
          this.cachedV2LsRefs.set(cacheKey, out);
        }
        return out;
      }
      if (command === 'fetch') {
        const cacheKey = rawBody.length <= 512 ? rawBody.toString('latin1') : null;
        if (cacheKey !== null) {
          const hit = this.cachedV2Fetch.get(cacheKey);
          if (hit) return hit;
        }
        const out = this.handleV2Fetch(lines);
        if (cacheKey !== null && this.cachedV2Fetch.size < 16) {
          this.cachedV2Fetch.set(cacheKey, out);
        }
        return out;
      }
    }
    return this.handleV0Fetch(lines);
  }

  private handleV2LsRefs(lines: string[]): Buffer {
    const prefixes: string[] = [];
    let includeSymrefs = false;
    let includePeel = false;

    for (const l of lines) {
      if (l === 'symrefs') includeSymrefs = true;
      else if (l === 'peel') includePeel = true;
      else if (l.startsWith('ref-prefix ')) prefixes.push(l.slice(11));
    }

    const matchPrefix = (refName: string): boolean => {
      if (prefixes.length === 0) return true;
      return prefixes.some((p) => refName.startsWith(p));
    };

    const outLines: string[] = [];
    const defaultHeadRef = `refs/heads/${this.defaultBranch}`;
    const headOid = this.refs.get(defaultHeadRef);

    if (headOid && matchPrefix('HEAD')) {
      outLines.push(includeSymrefs ? `${headOid} HEAD symref-target:${defaultHeadRef}\n` : `${headOid} HEAD\n`);
    } else if (!headOid && matchPrefix('HEAD') && includeSymrefs) {
      outLines.push(`unborn HEAD symref-target:${defaultHeadRef}\n`);
    }

    const sorted = [...this.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [refName, oid] of sorted) {
      if (!matchPrefix(refName)) continue;
      let suffix = '';
      if (includePeel) {
        const obj = this.objects.get(oid);
        if (obj?.type === 'tag') {
          suffix = ` peeled:${this.peelTag(oid)}`;
        }
      }
      outLines.push(`${oid} ${refName}${suffix}\n`);
    }
    return pktSequence(outLines, true);
  }

  private handleV2Fetch(lines: string[]): Buffer {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth = 0;

    for (const l of lines) {
      if (l.startsWith('want ')) wants.push(l.slice(5).trim());
      else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
      else if (l.startsWith('shallow ')) clientShallow.push(l.slice(8).trim());
      else if (l.startsWith('deepen ')) depth = Math.max(1, parseInt(l.slice(7).trim(), 10) || 1);
    }

    const { objectsToSend, shallowCommits, unshallowCommits } = this.computeFetchPlan(
      wants,
      haves,
      clientShallow,
      depth,
    );

    const sections: Buffer[] = [];
    if (shallowCommits.length > 0 || unshallowCommits.length > 0) {
      sections.push(pktLine('shallow-info\n'));
      for (const s of shallowCommits) sections.push(pktLine(`shallow ${s}\n`));
      for (const u of unshallowCommits) sections.push(pktLine(`unshallow ${u}\n`));
      sections.push(DELIM_PKT);
    }

    sections.push(pktLine('packfile\n'));
    const pack = assemblePackFromStored(objectsToSend);
    sections.push(wrapSidebandBand1(pack));
    return Buffer.concat(sections);
  }

  private handleV0Fetch(lines: string[]): Buffer {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth = 0;
    let useSideband = false;
    let seenDone = false;

    for (const l of lines) {
      if (l.startsWith('want ')) {
        const rest = l.slice(5).trim();
        const parts = rest.split(/\s+/);
        wants.push(parts[0]!);
        for (let i = 1; i < parts.length; i++) {
          if (parts[i] === 'side-band-64k' || parts[i] === 'side-band') {
            useSideband = true;
          }
        }
      } else if (l.startsWith('have ')) {
        haves.push(l.slice(5).trim());
      } else if (l.startsWith('shallow ')) {
        clientShallow.push(l.slice(8).trim());
      } else if (l.startsWith('deepen ')) {
        depth = Math.max(1, parseInt(l.slice(7).trim(), 10) || 1);
      } else if (l === 'done') {
        seenDone = true;
      }
    }

    if (wants.length === 0) {
      return pktSequence(['NAK\n'], false);
    }

    const { objectsToSend, shallowCommits, unshallowCommits } = this.computeFetchPlan(
      wants,
      haves,
      clientShallow,
      depth,
    );

    const outParts: Buffer[] = [];
    for (const s of shallowCommits) outParts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallowCommits) outParts.push(pktLine(`unshallow ${u}\n`));
    if (shallowCommits.length > 0 || unshallowCommits.length > 0) {
      outParts.push(FLUSH_PKT);
    }

    if (!seenDone && haves.length === 0 && depth === 0 && !useSideband) {
      outParts.push(pktLine('NAK\n'));
    } else {
      outParts.push(pktLine('NAK\n'));
    }

    const pack = assemblePackFromStored(objectsToSend);
    if (useSideband) {
      outParts.push(wrapSidebandBand1(pack));
    } else {
      outParts.push(pack);
    }
    return Buffer.concat(outParts);
  }

  /** 计算浅克隆边界与待传输对象子图 */
  private computeFetchPlan(
    wants: string[],
    haves: string[],
    clientShallow: string[],
    depth: number,
  ): {
    objectsToSend: GitObject[];
    shallowCommits: string[];
    unshallowCommits: string[];
  } {
    const clientShallowSet = new Set<string>(clientShallow);
    const haveObjSet = new Set<string>();

    const collectSubgraph = (rootOids: string[], stopCommitParentsAt?: Set<string>): Set<string> => {
      const seen = new Set<string>();
      const stack: string[] = [...rootOids];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        const obj = this.objects.get(oid);
        if (!obj) continue;
        seen.add(oid);
        if (obj.type === 'commit') {
          const c = this.getCommit(oid);
          if (c) {
            stack.push(c.tree);
            if (!stopCommitParentsAt || !stopCommitParentsAt.has(oid)) {
              for (const p of c.parents) stack.push(p);
            }
          }
        } else if (obj.type === 'tree') {
          const entries = this.getTree(oid);
          if (entries) {
            for (const e of entries) {
              if (e.mode !== '160000') stack.push(e.oid);
            }
          }
        } else if (obj.type === 'tag') {
          const t = this.getTag(oid);
          if (t) stack.push(t.object);
        }
      }
      return seen;
    };

    const commonAcks: string[] = [];
    for (const h of haves) {
      if (this.objects.has(h)) commonAcks.push(h);
    }
    if (commonAcks.length > 0) {
      for (const oid of collectSubgraph(commonAcks, clientShallowSet)) {
        haveObjSet.add(oid);
      }
    }

    const shallowLines: string[] = [];
    const unshallowLines: string[] = [];
    let wantObjSet: Set<string>;

    if (depth > 0) {
      const newShallowBoundary = new Set<string>();
      const allowedCommits = new Map<string, number>();
      const extraNonCommits: string[] = [];

      const bfs: Array<{ oid: string; gen: number }> = [];
      for (const w of wants) {
        const obj = this.objects.get(w);
        if (!obj) continue;
        if (obj.type === 'tag') {
          extraNonCommits.push(w);
          const peeled = this.peelTag(w);
          if (peeled && this.objects.get(peeled)?.type === 'commit') {
            bfs.push({ oid: peeled, gen: 1 });
          } else if (peeled) {
            extraNonCommits.push(peeled);
          }
        } else if (obj.type === 'commit') {
          bfs.push({ oid: w, gen: 1 });
        } else {
          extraNonCommits.push(w);
        }
      }

      while (bfs.length > 0) {
        const { oid, gen } = bfs.shift()!;
        const prevGen = allowedCommits.get(oid);
        if (prevGen !== undefined && prevGen <= gen) continue;
        allowedCommits.set(oid, gen);

        const c = this.getCommit(oid);
        if (!c) continue;
        if (gen < depth) {
          for (const p of c.parents) {
            bfs.push({ oid: p, gen: gen + 1 });
          }
        }
      }

      for (const [cOid, gen] of allowedCommits.entries()) {
        const c = this.getCommit(cOid);
        if (gen === depth && c && c.parents.length > 0) {
          newShallowBoundary.add(cOid);
        }
      }

      for (const s of newShallowBoundary) {
        if (!clientShallowSet.has(s)) shallowLines.push(s);
      }
      for (const oldS of clientShallowSet) {
        if (allowedCommits.has(oldS) && !newShallowBoundary.has(oldS)) {
          unshallowLines.push(oldS);
        }
      }

      wantObjSet = new Set<string>();
      const treeRoots: string[] = [...extraNonCommits];
      for (const cOid of allowedCommits.keys()) {
        wantObjSet.add(cOid);
        const c = this.getCommit(cOid);
        if (c) treeRoots.push(c.tree);
      }
      for (const oid of collectSubgraph(treeRoots)) {
        wantObjSet.add(oid);
      }
    } else {
      wantObjSet = collectSubgraph(wants);
    }

    const objectsToSend: GitObject[] = [];
    for (const oid of wantObjSet) {
      if (haveObjSet.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj) objectsToSend.push(obj);
    }

    return {
      objectsToSend,
      shallowCommits: shallowLines,
      unshallowCommits: unshallowLines,
    };
  }

  /** 处理 git-receive-pack编译 HTTP/1.1 二进制帧或动态构造） */
  handleReceivePackHttpFrame(rawBody: Buffer): Buffer {
    const { lines, trailingRaw } = decodeRequestPktStream(rawBody, true);

    interface RefCmd {
      oldOid: string;
      newOid: string;
      refName: string;
    }

    const commands: RefCmd[] = [];
    let reportStatus = false;
    let useSideband = false;

    for (const rawLine of lines) {
      if (rawLine === '__FLUSH__' || rawLine === '__DELIM__') continue;
      let line = rawLine;
      const nulIdx = line.indexOf('\0');
      if (nulIdx !== -1) {
        const capStr = line.slice(nulIdx + 1);
        line = line.slice(0, nulIdx);
        const capTokens = capStr.split(/\s+/);
        for (const c of capTokens) {
          if (c === 'report-status' || c === 'report-status-v2') reportStatus = true;
          else if (c === 'side-band-64k' || c === 'side-band') useSideband = true;
        }
      }
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
      if (m) {
        commands.push({ oldOid: m[1]!, newOid: m[2]!, refName: m[3]!.trim() });
      }
    }

    const needsPack = commands.some((c) => c.newOid !== ZERO_SHA);
    let unpackError: string | null = null;

    if (needsPack && trailingRaw.length > 0) {
      try {
        this.unpackPackfile(trailingRaw);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    } else if (needsPack && trailingRaw.length === 0) {
      const missing = commands.some((c) => c.newOid !== ZERO_SHA && !this.objects.has(c.newOid));
      if (missing) unpackError = 'Missing packfile for pushed objects';
    }

    const reportLines: string[] = [unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n'];
    let anyUpdated = false;

    for (const cmd of commands) {
      if (unpackError) {
        reportLines.push(`ng ${cmd.refName} ${unpackError}\n`);
        continue;
      }
      const curOid = this.refs.get(cmd.refName) ?? ZERO_SHA;
      if (curOid !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.refName} stale old oid (expected ${curOid})\n`);
        continue;
      }

      if (cmd.newOid === ZERO_SHA) {
        this.refs.delete(cmd.refName);
        anyUpdated = true;
        reportLines.push(`ok ${cmd.refName}\n`);
      } else {
        if (!this.objects.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.refName} missing object ${cmd.newOid}\n`);
        } else if (cmd.oldOid === ZERO_SHA) {
          this.refs.set(cmd.refName, cmd.newOid);
          anyUpdated = true;
          reportLines.push(`ok ${cmd.refName}\n`);
        } else if (cmd.refName.startsWith('refs/heads/') && !this.isAncestor(cmd.oldOid, cmd.newOid)) {
          reportLines.push(`ng ${cmd.refName} non-fast-forward\n`);
        } else {
          this.refs.set(cmd.refName, cmd.newOid);
          anyUpdated = true;
          reportLines.push(`ok ${cmd.refName}\n`);
        }
      }
    }

    if (anyUpdated) {
      this.bumpVersion();
    }

    if (!reportStatus) {
      return buildHttpFrame(200, GIT_RECEIVE_RES_CT, Buffer.alloc(0), 'Cache-Control: no-cache\r\n');
    }
    if (unpackError === null && reportLines.length === 2 && reportLines[1] === 'ok refs/heads/main\n') {
      return useSideband ? STATIC_PUSH_MAIN_SIDEBAND_OK_HTTP_FRAME : STATIC_PUSH_MAIN_RAW_OK_HTTP_FRAME;
    }

    const statusPayload = pktSequence(reportLines, true);
    const body = useSideband ? Buffer.concat([pktSideband(1, statusPayload), FLUSH_PKT]) : statusPayload;
    return buildHttpFrame(200, GIT_RECEIVE_RES_CT, body, 'Cache-Control: no-cache\r\n');
  }

  handleReceivePack(rawBody: Buffer): Buffer {
    const frame = this.handleReceivePackHttpFrame(rawBody);
    const sep = frame.indexOf('\r\n\r\n', 0, 'latin1');
    return sep >= 0 ? frame.subarray(sep + 4) : frame;
  }
}
