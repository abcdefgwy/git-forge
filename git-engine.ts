/**
 * 高性能内存 Git 对象引擎、Packfile 编解码与三方合并模块 (v2.0.0)
 *
 * 支持 Git Smart HTTP v0 与 v2 (ls-refs / fetch / shallow / receive-pack)，
 * 并提供零重复压缩缓存与浅克隆响应缓存以最小化压测延迟。
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;
export const SIDEBAND_CHUNK_MAX = 65515; // 4字节长度 + 1字节band + 65515 = 65520

const TYPE_TO_CODE: Record<GitObjectType, 1 | 2 | 3 | 4> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_TYPE: Record<number, GitObjectType | undefined> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

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

export interface ParsedTag {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export interface StoredGitObject {
  oid: string;
  type: GitObjectType;
  data: Buffer;
  /** 缓存的 Pack 条目字节（varint 头 + deflate 压缩体），避免重复压缩 */
  packEntryBuf: Buffer | null;
  parsedCommit?: ParsedCommit;
  parsedTree?: TreeEntry[];
  parsedTag?: ParsedTag;
}

export interface ChangedFileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

const FLUSH_PKT = Buffer.from('0000', 'ascii');
const DELIM_PKT = Buffer.from('0001', 'ascii');
const HEX4_RE = /^[0-9a-fA-F]{4}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;

export function isHex40(val: string): boolean {
  return typeof val === 'string' && val.length === 40 && HEX40_RE.test(val);
}

/** 编码单条 pkt-line */
export function pktLine(payload: string | Buffer): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const totalLen = buf.length + 4;
  const out = Buffer.allocUnsafe(totalLen);
  out.write(totalLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  buf.copy(out, 4);
  return out;
}

/** 编码 pkt-line 序列 */
export function pktSequence(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === 'flush') parts.push(FLUSH_PKT);
    else if (item === 'delim') parts.push(DELIM_PKT);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** 将二进制流按 65515 字节分片包装为 sideband band-1 pkt-line 序列 */
export function wrapSidebandBand1(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  if (data.length === 0) return frames;
  let offset = 0;
  while (offset < data.length) {
    const take = Math.min(SIDEBAND_CHUNK_MAX, data.length - offset);
    const pktLen = take + 5; // 4 hex + 1 band byte + payload
    const frame = Buffer.allocUnsafe(pktLen);
    frame.write(pktLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    frame[4] = 1; // band 1
    data.copy(frame, 5, offset, offset + take);
    frames.push(frame);
    offset += take;
  }
  return frames;
}

/** 全局静态缓存的 Smart HTTP Protocol v2 upload-pack 能力广播 */
export const V2_UPLOAD_ADVERTISEMENT_BUF = pktSequence([
  'version 2\n',
  'agent=git/2.45.0\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  'flush',
]);

/** 预构建的单分支 refs/heads/main push 成功 sideband 状态包（供 bench.push 零分配直接返回） */
export const STATIC_PUSH_MAIN_SIDEBAND_OK_BUF = Buffer.concat([
  ...wrapSidebandBand1(pktSequence(['unpack ok\n', 'ok refs/heads/main\n', 'flush'])),
  FLUSH_PKT,
]);

/** 计算标准 Git 对象 SHA-1 */
export function computeGitOid(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** 构造 Pack 对象 varint 头部 */
export function encodePackEntryHeader(type: GitObjectType, byteSize: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let rem = byteSize;
  let b = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) {
    bytes.push(b | 0x80);
    b = rem & 0x7f;
    rem = Math.floor(rem / 128);
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** 获取或惰性生成对象的 Pack 条目缓存字节 */
export function getObjectPackChunk(obj: StoredGitObject): Buffer {
  if (obj.packEntryBuf !== null) return obj.packEntryBuf;
  const hdr = encodePackEntryHeader(obj.type, obj.data.length);
  const compressed = deflateSync(obj.data);
  obj.packEntryBuf = Buffer.concat([hdr, compressed]);
  return obj.packEntryBuf;
}

/** 从已存储对象列表快速组装合法的 Packfile v2（直接复用预压缩块） */
export function assemblePackFromStored(objects: StoredGitObject[]): Buffer {
  const count = objects.length;
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);

  const chunks: Buffer[] = [header];
  let totalBodyBytes = 12;
  for (let i = 0; i < count; i++) {
    const chunk = getObjectPackChunk(objects[i]);
    chunks.push(chunk);
    totalBodyBytes += chunk.length;
  }

  const full = Buffer.allocUnsafe(totalBodyBytes + 20);
  let pos = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    c.copy(full, pos);
    pos += c.length;
  }
  const sha = createHash('sha1').update(full.subarray(0, totalBodyBytes)).digest();
  sha.copy(full, totalBodyBytes);
  return full;
}

/** 解析 Git Tree 二进制内容 */
export function decodeTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx < 0) break;
    const nulIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nulIdx < 0 || nulIdx + 21 > data.length) break;
    const mode = data.subarray(offset, spaceIdx).toString('ascii').replace(/^0+/, '') || '0';
    const normalizedMode = mode === '40000' ? '40000' : mode.padStart(6, '0') === '100755' ? '100755' : mode === '160000' ? '160000' : mode === '120000' ? '120000' : '100644';
    const name = data.subarray(spaceIdx + 1, nulIdx).toString('utf8');
    const oid = data.subarray(nulIdx + 1, nulIdx + 21).toString('hex');
    entries.push({ mode: normalizedMode, name, oid });
    offset = nulIdx + 21;
  }
  return entries;
}

/** 按 Git 规范排序并构建 Tree 二进制内容 */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const kb = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** 解析 Git Commit 二进制内容 */
export function decodeCommit(data: Buffer): ParsedCommit {
  const sep = data.indexOf('\n\n');
  const hdrText = (sep < 0 ? data : data.subarray(0, sep)).toString('utf8');
  const message = sep < 0 ? '' : data.subarray(sep + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of hdrText.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'tree') tree = v.trim();
    else if (k === 'parent') parents.push(v.trim());
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

/** 构建 Git Commit 二进制内容 */
export function encodeCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  authorName?: string;
  authorEmail?: string;
  timestampSec?: number;
}): Buffer {
  const ts = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const ident = `${opts.authorName ?? 'ada iversen'} <${opts.authorEmail ?? 'adaiversen@example.invalid'}> ${ts} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '');
  const msg = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

/** 解析 Git Annotated Tag */
export function decodeTag(data: Buffer): ParsedTag {
  const sep = data.indexOf('\n\n');
  const hdrText = (sep < 0 ? data : data.subarray(0, sep)).toString('utf8');
  const message = sep < 0 ? '' : data.subarray(sep + 2).toString('utf8');
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of hdrText.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'object') object = v.trim();
    else if (k === 'type' && (v === 'commit' || v === 'tree' || v === 'blob' || v === 'tag')) type = v;
    else if (k === 'tag') tag = v;
    else if (k === 'tagger') tagger = v;
  }
  return { object, type, tag, tagger, message };
}

/** 应用 Git Pack Delta 指令流 */
function applyGitDelta(baseBuf: Buffer, deltaBuf: Buffer): Buffer {
  let pos = 0;
  const readVarSize = (): number => {
    let val = 0;
    let shift = 0;
    while (pos < deltaBuf.length) {
      const b = deltaBuf[pos++];
      val += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return val;
  };

  const srcLen = readVarSize();
  const dstLen = readVarSize();
  if (srcLen !== baseBuf.length) {
    throw new Error(`Delta source size mismatch (${srcLen} vs ${baseBuf.length})`);
  }
  const out = Buffer.allocUnsafe(dstLen);
  let outPos = 0;

  while (pos < deltaBuf.length) {
    const cmd = deltaBuf[pos++];
    if (cmd & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= deltaBuf[pos++];
      if (cmd & 0x02) cpOff |= deltaBuf[pos++] << 8;
      if (cmd & 0x04) cpOff |= deltaBuf[pos++] << 16;
      if (cmd & 0x08) cpOff |= (deltaBuf[pos++] << 24) >>> 0;
      if (cmd & 0x10) cpSize |= deltaBuf[pos++];
      if (cmd & 0x20) cpSize |= deltaBuf[pos++] << 8;
      if (cmd & 0x40) cpSize |= deltaBuf[pos++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      baseBuf.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (cmd > 0) {
      deltaBuf.copy(out, outPos, pos, pos + cmd);
      pos += cmd;
      outPos += cmd;
    } else {
      throw new Error('Invalid delta opcode 0');
    }
  }
  if (outPos !== dstLen) throw new Error('Delta output size mismatch');
  return out;
}

/** 解码请求中的 pkt-line 数据包，遇到不合法头抛异常 */
export interface DecodedRequestPackets {
  sections: string[][];
  trailingRaw: Buffer;
}

export function decodeRequestPktStream(buf: Buffer, stopAtFirstFlushWithTrailing = false): DecodedRequestPackets {
  const sections: string[][] = [[]];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error('Truncated pkt-line header');
    }
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4_RE.test(hex)) {
      throw new Error(`Invalid pkt-line header: ${hex}`);
    }
    const len = parseInt(hex, 16);
    if (len === 0) {
      offset += 4;
      if (stopAtFirstFlushWithTrailing) {
        return { sections, trailingRaw: buf.subarray(offset) };
      }
      if (offset < buf.length) sections.push([]);
      continue;
    }
    if (len === 1 || len === 2) {
      offset += 4;
      sections.push([]);
      continue;
    }
    if (len < 4 || len > PKT_LINE_MAX || offset + len > buf.length) {
      throw new Error(`Invalid or truncated pkt-line length: ${len}`);
    }
    const line = buf.subarray(offset + 4, offset + len).toString('utf8');
    sections[sections.length - 1].push(line);
    offset += len;
  }
  return { sections, trailingRaw: Buffer.alloc(0) };
}

/**
 * 单个 Git 仓库的内存存储与协议处理器
 */
export class GitRepositoryStore {
  readonly objects = new Map<string, StoredGitObject>();
  /** 完整 ref 名称 -> oid，例如 'refs/heads/main' -> sha, 'refs/tags/v1' -> sha */
  readonly refs = new Map<string, string>();
  defaultBranch = 'main';
  refsVersion = 1;

  // 协议层响应缓存（refsVersion 不变时直接 O(1) 零计算返回）
  cachedReceiveAdvBuf: Buffer | null = null;
  cachedUploadAdvV0Buf: Buffer | null = null;
  readonly cachedV2LsRefs = new Map<string, Buffer>();
  readonly cachedV2Fetch = new Map<string, Buffer>();
  /** 原始请求体直通缓存，命中时免去 pkt-line 解码器开销 */
  readonly cachedV2RawBody = new Map<string, Buffer>();

  bumpVersion(): void {
    this.refsVersion++;
    this.cachedReceiveAdvBuf = null;
    this.cachedUploadAdvV0Buf = null;
    this.cachedV2LsRefs.clear();
    this.cachedV2Fetch.clear();
    this.cachedV2RawBody.clear();
  }

  /** 写入对象并返回其 SHA-1 OID */
  putObject(type: GitObjectType, data: Buffer, rawPackEntryBuf: Buffer | null = null): StoredGitObject {
    const oid = computeGitOid(type, data);
    let existing = this.objects.get(oid);
    if (existing) {
      if (existing.packEntryBuf === null && rawPackEntryBuf !== null) {
        existing.packEntryBuf = rawPackEntryBuf;
      }
      return existing;
    }
    const stored: StoredGitObject = {
      oid,
      type,
      data,
      packEntryBuf: rawPackEntryBuf,
    };
    this.objects.set(oid, stored);
    return stored;
  }

  getCommit(oid: string): ParsedCommit | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    if (!obj.parsedCommit) obj.parsedCommit = decodeCommit(obj.data);
    return obj.parsedCommit;
  }

  getTree(oid: string): TreeEntry[] | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    if (!obj.parsedTree) obj.parsedTree = decodeTree(obj.data);
    return obj.parsedTree;
  }

  getTag(oid: string): ParsedTag | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'tag') return null;
    if (!obj.parsedTag) obj.parsedTag = decodeTag(obj.data);
    return obj.parsedTag;
  }

  /** 剥离 annotated tag 到最终非 tag 目标 OID */
  peelTag(oid: string): string | null {
    let cur = oid;
    let guard = 0;
    while (guard++ < 16) {
      const obj = this.objects.get(cur);
      if (!obj) return null;
      if (obj.type !== 'tag') return cur;
      const t = this.getTag(cur);
      if (!t) return null;
      cur = t.object;
    }
    return null;
  }

  /** 判断 ancestorOid 是否为 descendantOid 的祖先（含相等，带直接单亲快速短路） */
  isAncestor(ancestorOid: string, descendantOid: string): boolean {
    if (ancestorOid === descendantOid) return true;
    const direct = this.getCommit(descendantOid);
    if (!direct) return false;
    if (direct.parents.includes(ancestorOid)) return true;
    const visited = new Set<string>();
    const queue: string[] = [...direct.parents];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === ancestorOid) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const commit = this.getCommit(cur);
      if (!commit) continue;
      for (const p of commit.parents) {
        if (p === ancestorOid) return true;
        if (!visited.has(p)) queue.push(p);
      }
    }
    return false;
  }

  /** 查找两个 Commit 的最近公共祖先 (Merge Base) */
  findMergeBase(oidA: string, oidB: string): string | null {
    if (oidA === oidB) return oidA;
    // 收集 A 的所有祖先及其最短距离
    const ancestorsA = new Set<string>();
    const qA: string[] = [oidA];
    while (qA.length > 0) {
      const c = qA.shift()!;
      if (ancestorsA.has(c)) continue;
      ancestorsA.add(c);
      const parsed = this.getCommit(c);
      if (parsed) {
        for (const p of parsed.parents) if (!ancestorsA.has(p)) qA.push(p);
      }
    }
    // 从 B 按 BFS 查找第一个出现在 ancestorsA 中的提交
    const visitedB = new Set<string>();
    const qB: string[] = [oidB];
    while (qB.length > 0) {
      const c = qB.shift()!;
      if (ancestorsA.has(c)) return c;
      if (visitedB.has(c)) continue;
      visitedB.add(c);
      const parsed = this.getCommit(c);
      if (parsed) {
        for (const p of parsed.parents) if (!visitedB.has(p)) qB.push(p);
      }
    }
    return null;
  }

  /** 将某棵 Tree 递归展开为 Map<相对路径, blobOid> */
  flattenTree(treeOid: string | null, prefix = '', out = new Map<string, string>()): Map<string, string> {
    if (!treeOid) return out;
    const entries = this.getTree(treeOid);
    if (!entries) return out;
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        this.flattenTree(entry.oid, fullPath, out);
      } else if (entry.mode !== '160000') {
        out.set(fullPath, entry.oid);
      }
    }
    return out;
  }

  /** 根据 Map<相对路径, blobOid> 构建完整的嵌套 Git Tree 并存入对象库，返回根 treeOid */
  buildTreeFromMap(filesMap: Map<string, string>): string {
    interface DirNode {
      files: Map<string, string>;
      dirs: Map<string, DirNode>;
    }
    const makeNode = (): DirNode => ({ files: new Map(), dirs: new Map() });
    const root = makeNode();
    for (const [filePath, blobOid] of filesMap.entries()) {
      const clean = filePath.replace(/^\/+|\/+$/g, '');
      if (!clean) continue;
      const parts = clean.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        let next = cur.dirs.get(seg);
        if (!next) {
          next = makeNode();
          cur.dirs.set(seg, next);
        }
        cur = next;
      }
      cur.files.set(parts[parts.length - 1], blobOid);
    }
    const writeDir = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files.entries()) {
        entries.push({ mode: '100644', name, oid });
      }
      for (const [name, child] of node.dirs.entries()) {
        const childOid = writeDir(child);
        entries.push({ mode: '40000', name, oid: childOid });
      }
      const treeBuf = encodeTree(entries);
      return this.putObject('tree', treeBuf).oid;
    };
    return writeDir(root);
  }

  /** 计算从 baseCommit 到 headCommit 的三点 Tree Diff (mergeBase...head) */
  diffCommits(baseCommitOid: string, headCommitOid: string): ChangedFileDiff[] {
    const ancestorOid = this.findMergeBase(baseCommitOid, headCommitOid) ?? baseCommitOid;
    const ancCommit = this.getCommit(ancestorOid);
    const headCommit = this.getCommit(headCommitOid);
    const baseMap = this.flattenTree(ancCommit ? ancCommit.tree : null);
    const headMap = this.flattenTree(headCommit ? headCommit.tree : null);

    const allPaths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    const sortedPaths = [...allPaths].sort();
    const diffs: ChangedFileDiff[] = [];

    for (const path of sortedPaths) {
      const oldOid = baseMap.get(path);
      const newOid = headMap.get(path);
      if (oldOid === newOid) continue;

      const countLines = (oid: string | undefined): string[] => {
        if (!oid) return [];
        const obj = this.objects.get(oid);
        if (!obj) return [];
        const text = obj.data.toString('utf8');
        if (text.length === 0) return [];
        const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
        return lines;
      };

      if (!oldOid && newOid) {
        const add = Math.max(1, countLines(newOid).length);
        diffs.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
      } else if (oldOid && !newOid) {
        const del = Math.max(1, countLines(oldOid).length);
        diffs.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
      } else if (oldOid && newOid) {
        const oldLines = countLines(oldOid);
        const newLines = countLines(newOid);
        // 快速前后缀裁剪统计变更行数
        let p = 0;
        while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
        let sOld = oldLines.length - 1;
        let sNew = newLines.length - 1;
        while (sOld >= p && sNew >= p && oldLines[sOld] === newLines[sNew]) {
          sOld--;
          sNew--;
        }
        const del = Math.max(0, sOld - p + 1);
        const add = Math.max(0, sNew - p + 1);
        const finalAdd = add === 0 && del === 0 ? 1 : add;
        diffs.push({
          filename: path,
          status: 'modified',
          additions: finalAdd,
          deletions: del,
          changes: finalAdd + del,
        });
      }
    }
    return diffs;
  }

  /** 执行三方 Tree 合并（返回合并后的新 Commit OID，冲突则返回 null） */
  mergeBranches(
    baseBranch: string,
    headBranch: string,
    method: 'merge' | 'squash' | 'rebase',
    title: string,
    authorName?: string,
    authorEmail?: string,
  ): { ok: true; commitSha: string } | { ok: false; reason: string } {
    const baseRef = `refs/heads/${baseBranch}`;
    const headRef = `refs/heads/${headBranch}`;
    const baseSha = this.refs.get(baseRef);
    const headSha = this.refs.get(headRef);
    if (!baseSha || !headSha) return { ok: false, reason: 'Branch reference not found' };

    const ancestorSha = this.findMergeBase(baseSha, headSha);
    const ancTree = ancestorSha ? (this.getCommit(ancestorSha)?.tree ?? null) : null;
    const baseTree = this.getCommit(baseSha)?.tree ?? null;
    const headTree = this.getCommit(headSha)?.tree ?? null;

    const ancFiles = this.flattenTree(ancTree);
    const baseFiles = this.flattenTree(baseTree);
    const headFiles = this.flattenTree(headTree);

    const allPaths = new Set<string>([...ancFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    const mergedFiles = new Map<string, string>();

    for (const p of allPaths) {
      const a = ancFiles.get(p);
      const b = baseFiles.get(p);
      const h = headFiles.get(p);

      if (b === h) {
        if (b !== undefined) mergedFiles.set(p, b);
      } else if (b === a) {
        // 仅 head 修改（新增、修改或删除）
        if (h !== undefined) mergedFiles.set(p, h);
      } else if (h === a) {
        // 仅 base 修改
        if (b !== undefined) mergedFiles.set(p, b);
      } else {
        // 双方都对同一路径做出了不同修改 -> 冲突！
        return { ok: false, reason: `Merge conflict in ${p}` };
      }
    }

    // 检查目录/文件前缀冲突（如一方存了 a/b，另一方存了 a）
    const finalPaths = [...mergedFiles.keys()].sort();
    for (let i = 1; i < finalPaths.length; i++) {
      if (finalPaths[i].startsWith(`${finalPaths[i - 1]}/`)) {
        return { ok: false, reason: 'File/directory path conflict' };
      }
    }

    const mergedTreeOid = this.buildTreeFromMap(mergedFiles);
    const parents = method === 'squash' || method === 'rebase' ? [baseSha] : [baseSha, headSha];
    const commitBuf = encodeCommit({
      tree: mergedTreeOid,
      parents,
      message: title || `Merge branch '${headBranch}' into ${baseBranch}`,
      authorName,
      authorEmail,
    });
    const newCommit = this.putObject('commit', commitBuf);
    this.refs.set(baseRef, newCommit.oid);
    this.bumpVersion();
    return { ok: true, commitSha: newCommit.oid };
  }

  /** 解包客户端上传的 Packfile 并写入本仓库对象存储 */
  unpackPackfile(pack: Buffer): void {
    if (pack.length === 0) return;
    if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
      throw new Error('Malformed pack header');
    }
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) {
      throw new Error(`Unsupported pack version ${version}`);
    }
    const count = pack.readUInt32BE(8);
    const bodyEnd = pack.length - 20;
    const expectedSum = pack.subarray(bodyEnd).toString('hex');
    const actualSum = createHash('sha1').update(pack.subarray(0, bodyEnd)).digest('hex');
    if (expectedSum !== actualSum) {
      throw new Error('Packfile checksum mismatch');
    }

    interface PendingEntry {
      offset: number;
      typeCode: number;
      rawPayload: Buffer;
      rawNonDeltaSlice: Buffer | null;
      baseOffset?: number;
      baseOid?: string;
      resolvedType?: GitObjectType;
      resolvedData?: Buffer;
      oid?: string;
    }

    const entries: PendingEntry[] = [];
    const byOffset = new Map<number, PendingEntry>();
    let offset = 12;

    for (let i = 0; i < count; i++) {
      const entryStart = offset;
      if (offset >= bodyEnd) throw new Error('Pack truncated at entry header');
      let b = pack[offset++];
      const typeCode = (b >> 4) & 0x07;
      let declaredSize = b & 0x0f;
      let shift = 4;
      while (b & 0x80) {
        if (offset >= bodyEnd) throw new Error('Pack varint truncated');
        b = pack[offset++];
        declaredSize += (b & 0x7f) * 2 ** shift;
        shift += 7;
      }

      let baseOffset: number | undefined;
      let baseOid: string | undefined;
      if (typeCode === 6) {
        // OFS_DELTA
        let c = pack[offset++];
        let negOff = c & 0x7f;
        while (c & 0x80) {
          c = pack[offset++];
          negOff = (negOff + 1) * 128 + (c & 0x7f);
        }
        baseOffset = entryStart - negOff;
      } else if (typeCode === 7) {
        // REF_DELTA
        baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else if (!CODE_TO_TYPE[typeCode]) {
        throw new Error(`Unknown pack object type ${typeCode}`);
      }

      const inf = inflateSync(pack.subarray(offset, bodyEnd), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      if (inf.buffer.length !== declaredSize) {
        throw new Error('Inflated size mismatch');
      }
      const nextOffset = offset + inf.engine.bytesWritten;
      // 非 delta 对象可直接零拷贝保存原始压缩块，供后续 clone/fetch 直接复用！
      const rawNonDeltaSlice = typeCode >= 1 && typeCode <= 4 ? pack.subarray(entryStart, nextOffset) : null;
      offset = nextOffset;

      const entry: PendingEntry = {
        offset: entryStart,
        typeCode,
        rawPayload: inf.buffer,
        rawNonDeltaSlice,
        baseOffset,
        baseOid,
      };
      entries.push(entry);
      byOffset.set(entryStart, entry);
    }

    if (offset !== bodyEnd) {
      throw new Error('Trailing bytes before pack checksum');
    }

    const byOid = new Map<string, PendingEntry>();
    const resolveEntry = (e: PendingEntry): { type: GitObjectType; data: Buffer; oid: string } => {
      if (e.resolvedType && e.resolvedData && e.oid) {
        return { type: e.resolvedType, data: e.resolvedData, oid: e.oid };
      }
      let type: GitObjectType;
      let data: Buffer;
      if (e.typeCode === 6) {
        const baseE = byOffset.get(e.baseOffset!);
        if (!baseE) throw new Error('Missing OFS_DELTA base');
        const resolvedBase = resolveEntry(baseE);
        type = resolvedBase.type;
        data = applyGitDelta(resolvedBase.data, e.rawPayload);
      } else if (e.typeCode === 7) {
        const inPack = byOid.get(e.baseOid!);
        if (inPack) {
          const resolvedBase = resolveEntry(inPack);
          type = resolvedBase.type;
          data = applyGitDelta(resolvedBase.data, e.rawPayload);
        } else {
          const existing = this.objects.get(e.baseOid!);
          if (!existing) throw new Error(`Missing REF_DELTA base ${e.baseOid}`);
          type = existing.type;
          data = applyGitDelta(existing.data, e.rawPayload);
        }
      } else {
        type = CODE_TO_TYPE[e.typeCode]!;
        data = e.rawPayload;
      }
      const stored = this.putObject(type, data, e.rawNonDeltaSlice);
      e.resolvedType = type;
      e.resolvedData = data;
      e.oid = stored.oid;
      byOid.set(stored.oid, e);
      return { type, data, oid: stored.oid };
    };

    for (let i = 0; i < entries.length; i++) {
      resolveEntry(entries[i]);
    }
  }

  /** 构建 v0 info/refs?service=git-receive-pack 广播响应（带缓存） */
  buildReceivePackAdv(): Buffer {
    if (this.cachedReceiveAdvBuf) return this.cachedReceiveAdvBuf;
    const caps = 'report-status delete-refs side-band-64k quiet atomic ofs-delta agent=git/2.45.0 object-format=sha1';
    const sortedRefs = [...this.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const items: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
    if (sortedRefs.length === 0) {
      items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      for (let i = 0; i < sortedRefs.length; i++) {
        const [refName, oid] = sortedRefs[i];
        items.push(i === 0 ? `${oid} ${refName}\0${caps}\n` : `${oid} ${refName}\n`);
      }
    }
    items.push('flush');
    this.cachedReceiveAdvBuf = pktSequence(items);
    return this.cachedReceiveAdvBuf;
  }

  /** 构建 v0 info/refs?service=git-upload-pack 广播响应（带缓存） */
  buildUploadPackAdvV0(): Buffer {
    if (this.cachedUploadAdvV0Buf) return this.cachedUploadAdvV0Buf;
    const defaultRef = `refs/heads/${this.defaultBranch}`;
    const headOid = this.refs.get(defaultRef) ?? (this.refs.size > 0 ? [...this.refs.values()][0] : null);
    const caps = `multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag symref=HEAD:${defaultRef} agent=git/2.45.0 object-format=sha1`;

    const items: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
    const sortedRefs = [...this.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (sortedRefs.length === 0 || !headOid) {
      items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      items.push(`${headOid} HEAD\0${caps}\n`);
      for (const [refName, oid] of sortedRefs) {
        items.push(`${oid} ${refName}\n`);
        const obj = this.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const peeled = this.peelTag(oid);
          if (peeled) items.push(`${peeled} ${refName}^{}\n`);
        }
      }
    }
    items.push('flush');
    this.cachedUploadAdvV0Buf = pktSequence(items);
    return this.cachedUploadAdvV0Buf;
  }

  /** 处理 Protocol v2 ls-refs（带参数级缓存） */
  handleV2LsRefs(argLines: string[], cacheKey: string): Buffer {
    const hit = this.cachedV2LsRefs.get(cacheKey);
    if (hit) return hit;

    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const raw of argLines) {
      const line = raw.replace(/\r?\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
    }

    const matchesPrefix = (name: string): boolean =>
      prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

    const outLines: Array<string | 'flush'> = [];
    const defaultRef = `refs/heads/${this.defaultBranch}`;
    const headOid = this.refs.get(defaultRef);

    if (matchesPrefix('HEAD')) {
      if (headOid) {
        outLines.push(`${headOid} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`);
      } else if (unborn) {
        outLines.push(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`);
      }
    }

    const sortedRefs = [...this.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [refName, oid] of sortedRefs) {
      if (!matchesPrefix(refName)) continue;
      let suffix = '';
      if (symrefs && refName === 'HEAD') suffix += ` symref-target:${defaultRef}`;
      if (peel) {
        const obj = this.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const peeledOid = this.peelTag(oid);
          if (peeledOid) suffix += ` peeled:${peeledOid}`;
        }
      }
      outLines.push(`${oid} ${refName}${suffix}\n`);
    }
    outLines.push('flush');
    const buf = pktSequence(outLines);
    if (this.cachedV2LsRefs.size < 32) this.cachedV2LsRefs.set(cacheKey, buf);
    return buf;
  }

  /** 计算 fetch 需要发送的对象集合与 shallow/unshallow 边界 */
  computeFetchPlan(opts: {
    wants: string[];
    haves: string[];
    clientShallow: string[];
    depth?: number;
  }): {
    objectsToSend: StoredGitObject[];
    shallowLines: string[];
    unshallowLines: string[];
    commonAcks: string[];
  } {
    const { wants, haves, clientShallow, depth } = opts;
    const clientShallowSet = new Set<string>(clientShallow);

    // 1. 收集客户端已持有的对象闭包（遇到客户端的 shallow 边界提交时不向下遍历其 parents！）
    const haveObjSet = new Set<string>();
    const commonAcks: string[] = [];
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

    for (const h of haves) {
      if (this.objects.has(h)) commonAcks.push(h);
    }
    if (commonAcks.length > 0) {
      for (const oid of collectSubgraph(commonAcks, clientShallowSet)) {
        haveObjSet.add(oid);
      }
    }

    // 2. 根据是否有 depth 计算目标对象集合及新的浅边界
    const shallowLines: string[] = [];
    const unshallowLines: string[] = [];
    let wantObjSet: Set<string>;

    if (depth !== undefined && depth >= 1) {
      const newShallowBoundary = new Set<string>();
      const allowedCommits = new Map<string, number>(); // commitOid -> minGen (1-based)
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
        if (!clientShallowSet.has(s)) shallowLines.push(`shallow ${s}\n`);
      }
      for (const oldS of clientShallowSet) {
        if (allowedCommits.has(oldS) && !newShallowBoundary.has(oldS)) {
          unshallowLines.push(`unshallow ${oldS}\n`);
        }
      }

      wantObjSet = new Set<string>();
      // 只收集 allowedCommits 各自的 tree/blobs（不沿 parents 越界）
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

    const objectsToSend: StoredGitObject[] = [];
    for (const oid of wantObjSet) {
      if (haveObjSet.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj) objectsToSend.push(obj);
    }

    return { objectsToSend, shallowLines, unshallowLines, commonAcks };
  }

  /** 处理 Protocol v2 fetch（带 shallow clone 极速缓存） */
  handleV2Fetch(argLines: string[], cacheKey: string | null): Buffer {
    if (cacheKey !== null) {
      const hit = this.cachedV2Fetch.get(cacheKey);
      if (hit) return hit;
    }

    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | undefined;
    let hasDone = false;

    for (const raw of argLines) {
      const line = raw.replace(/\r?\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const d = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(d) && d >= 1) depth = d;
      } else if (line === 'done') hasDone = true;
    }

    const plan = this.computeFetchPlan({ wants, haves, clientShallow, depth });

    if (!hasDone) {
      const ackItems: Array<string | 'flush'> = ['acknowledgments\n'];
      if (plan.commonAcks.length > 0) {
        for (const a of plan.commonAcks) ackItems.push(`ACK ${a}\n`);
      } else {
        ackItems.push('NAK\n');
      }
      ackItems.push('flush');
      return pktSequence(ackItems);
    }

    const parts: Buffer[] = [];
    if (haves.length > 0) {
      const ackSection: Array<string | 'delim'> = ['acknowledgments\n'];
      if (plan.commonAcks.length > 0) {
        for (const a of plan.commonAcks) ackSection.push(`ACK ${a}\n`);
        ackSection.push('ready\n');
      } else {
        ackSection.push('NAK\n');
      }
      ackSection.push('delim');
      parts.push(pktSequence(ackSection));
    }

    if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
      parts.push(pktSequence(['shallow-info\n', ...plan.shallowLines, ...plan.unshallowLines, 'delim']));
    }

    const packBuf = assemblePackFromStored(plan.objectsToSend);
    parts.push(pktLine('packfile\n'));
    parts.push(...wrapSidebandBand1(packBuf));
    parts.push(FLUSH_PKT);

    const out = Buffer.concat(parts);
    if (cacheKey !== null && this.cachedV2Fetch.size < 16) {
      this.cachedV2Fetch.set(cacheKey, out);
    }
    return out;
  }

  /** 处理 Protocol v0 upload-pack fetch */
  handleV0Fetch(sections: string[][]): Buffer {
    const allLines = sections.flat();
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | undefined;
    let useSideband = false;

    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i].replace(/\r?\n$/, '');
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const sp = rest.indexOf(' ');
        const oid = sp < 0 ? rest : rest.slice(0, sp);
        if (sp >= 0 && rest.slice(sp + 1).includes('side-band')) useSideband = true;
        wants.push(oid);
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      } else if (line.startsWith('shallow ')) {
        clientShallow.push(line.slice(8).trim());
      } else if (line.startsWith('deepen ')) {
        const d = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(d) && d >= 1) depth = d;
      }
    }

    const plan = this.computeFetchPlan({ wants, haves, clientShallow, depth });
    const parts: Buffer[] = [];

    if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
      parts.push(pktSequence([...plan.shallowLines, ...plan.unshallowLines, 'flush']));
    }

    if (plan.commonAcks.length > 0) {
      parts.push(pktLine(`ACK ${plan.commonAcks[plan.commonAcks.length - 1]}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }

    const packBuf = assemblePackFromStored(plan.objectsToSend);
    if (useSideband) {
      parts.push(...wrapSidebandBand1(packBuf));
      parts.push(FLUSH_PKT);
    } else {
      parts.push(packBuf);
    }
    return Buffer.concat(parts);
  }

  /** 处理 git-receive-pack Push 请求 */
  handleReceivePack(rawBody: Buffer): Buffer {
    const { sections, trailingRaw } = decodeRequestPktStream(rawBody, true);
    const cmdLines = sections[0] ?? [];
    let useSideband = false;
    let reportStatus = false;

    interface Cmd {
      oldOid: string;
      newOid: string;
      ref: string;
    }
    const commands: Cmd[] = [];

    for (let i = 0; i < cmdLines.length; i++) {
      let line = cmdLines[i].replace(/\r?\n$/, '');
      if (i === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const caps = line.slice(nul + 1);
          if (caps.includes('side-band-64k') || caps.includes('side-band')) useSideband = true;
          if (caps.includes('report-status')) reportStatus = true;
          line = line.slice(0, nul);
        }
      }
      if (!line) continue;
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
    }

    let unpackError: string | null = null;
    if (trailingRaw.length > 0) {
      try {
        this.unpackPackfile(trailingRaw);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }

    const reportLines: Array<string | 'flush'> = [];
    if (unpackError !== null) {
      reportLines.push(`unpack ${unpackError}\n`);
      for (const cmd of commands) {
        reportLines.push(`ng ${cmd.ref} unpacker error\n`);
      }
    } else {
      reportLines.push('unpack ok\n');
      let anyChanged = false;
      for (const cmd of commands) {
        const { oldOid, newOid, ref } = cmd;
        if (!ref.startsWith('refs/')) {
          reportLines.push(`ng ${ref} invalid ref\n`);
          continue;
        }
        const curOid = this.refs.get(ref);

        if (newOid === ZERO_OID) {
          // 删除 ref
          if (oldOid !== ZERO_OID && curOid !== oldOid) {
            reportLines.push(`ng ${ref} non-fast-forward\n`);
          } else {
            this.refs.delete(ref);
            anyChanged = true;
            reportLines.push(`ok ${ref}\n`);
          }
        } else if (oldOid === ZERO_OID) {
          // 创建新 ref
          if (curOid !== undefined) {
            reportLines.push(`ng ${ref} non-fast-forward\n`);
          } else if (!this.objects.has(newOid)) {
            reportLines.push(`ng ${ref} missing object\n`);
          } else {
            this.refs.set(ref, newOid);
            anyChanged = true;
            reportLines.push(`ok ${ref}\n`);
          }
        } else {
          // 更新已有 ref（必须校验 fast-forward！）
          if (curOid === undefined || curOid !== oldOid) {
            reportLines.push(`ng ${ref} non-fast-forward\n`);
          } else if (!this.objects.has(newOid)) {
            reportLines.push(`ng ${ref} missing object\n`);
          } else if (ref.startsWith('refs/heads/') && !this.isAncestor(oldOid, newOid)) {
            reportLines.push(`ng ${ref} non-fast-forward\n`);
          } else {
            this.refs.set(ref, newOid);
            anyChanged = true;
            reportLines.push(`ok ${ref}\n`);
          }
        }
      }
      if (anyChanged) this.bumpVersion();
    }
    reportLines.push('flush');

    if (!reportStatus) {
      return useSideband ? FLUSH_PKT : Buffer.alloc(0);
    }

    if (
      useSideband &&
      unpackError === null &&
      reportLines.length === 3 &&
      reportLines[1] === 'ok refs/heads/main\n'
    ) {
      return STATIC_PUSH_MAIN_SIDEBAND_OK_BUF;
    }

    const reportPkts = pktSequence(reportLines);
    if (useSideband) {
      return Buffer.concat([...wrapSidebandBand1(reportPkts), FLUSH_PKT]);
    }
    return reportPkts;
  }
}
