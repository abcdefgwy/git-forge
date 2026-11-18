/**
 * Git Forge 统一存储层与预序列化实体模型 (v2.1.0)
 *
 * 将 Git 底层对象库与 REST v3 / GraphQL v4 / MCP 资源视图实时联动，
 * 并对高频访问的 Issue 实体预编译完整的 HTTP/1.1 Keep-Alive 响应帧。
 */

import { GitRepositoryStore, encodeCommit, isHex40, type ChangedFileDiff } from './git-engine.ts';

export const DEFAULT_VIEWER_LOGIN = 'adaiversen';
export const DEFAULT_VIEWER_NAME = 'ada iversen';
export const DEFAULT_VIEWER_EMAIL = 'adaiversen@example.invalid';

let cachedIsoMs = -1;
let cachedIsoStr = '';

/** 毫秒级缓存 ISO 时间戳字符串，消除高频写压测中的日期格式化开销 */
export function fastNowIso(): { ms: number; iso: string } {
  const ms = Date.now();
  if (ms !== cachedIsoMs) {
    cachedIsoMs = ms;
    cachedIsoStr = new Date(ms).toISOString();
  }
  return { ms, iso: cachedIsoStr };
}

/** 对纯 ASCII 安全字符串免去 JSON.stringify 开销 */
function fastJsonString(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 34 || c === 92 || c >= 0xd800) {
      return JSON.stringify(s);
    }
  }
  return `"${s}"`;
}

/** 构造轻量级不透明全局 Relay Node ID（零 Buffer 分配） */
export function encodeNodeId(kind: 'R' | 'I' | 'PR' | 'C', numericId: number): string {
  return `GQL_${kind}_${numericId}`;
}

export interface LabelItem {
  name: string;
  color: string;
}

export interface CommentRecord {
  id: number;
  node_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface IssueRecord {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelItem[];
  comments: CommentRecord[];
  createdAtMs: number;
  created_at: string;
  updated_at: string;
  /** 预序列化的 REST JSON Buffer（直接作为 restHttp200Frame 的零拷贝 subarray） */
  restJsonBuf: Buffer;
  /** 预编译的完整 HTTP/1.1 200 OK Keep-Alive 二进制响应帧 */
  restHttp200Frame: Buffer;
  /** 兼容保留字段 */
  restHeaders: string[];
}

export interface PullRequestRecord {
  id: number;
  node_id: string;
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  createdAtMs: number;
  created_at: string;
  updated_at: string;
}

export interface RepoRecord {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  fullNameBuf: Buffer;
  owner: string;
  ownerJson: string;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  git: GitRepositoryStore;
  /** 精确保存通过 REST 创建的 commit 原始 message */
  exactCommitMessages: Map<string, string>;
  labels: Map<string, LabelItem>;
  issuesList: IssueRecord[];
  /** 下标 number (1-based) 快速数组，支持 GET /issues/:number 纳秒级索引 */
  issuesByNumber: Array<IssueRecord | undefined>;
  nextIssueNumber: number;
  pullsList: PullRequestRecord[];
  pullsByNumber: Map<number, PullRequestRecord>;
  nextPullNumber: number;
}

function buildIssueJsonString(issue: IssueRecord, owner: string, ownerJson: string): string {
  if (issue.labels.length === 0) {
    return (
      `{"id":${issue.id},"node_id":"${issue.node_id}","number":${issue.number},` +
      `"title":${fastJsonString(issue.title)},"body":${fastJsonString(issue.body)},` +
      `"state":"${issue.state}","labels":[],"comments":${issue.comments.length},` +
      `"user":{"login":${ownerJson},"id":1000,"type":"User"},` +
      `"created_at":"${issue.created_at}","updated_at":"${issue.updated_at}"}`
    );
  }
  return JSON.stringify({
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments.length,
    user: { login: owner, id: 1000, type: 'User' },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  });
}

export function buildIssueRestBuffer(issue: IssueRecord, owner: string): Buffer {
  return Buffer.from(buildIssueJsonString(issue, owner, JSON.stringify(owner)), 'utf8');
}

export function buildIssue201Frame(issue: IssueRecord): Buffer {
  const body = issue.restJsonBuf;
  const hdr =
    `HTTP/1.1 201 Created\r\nContent-Type: application/json; charset=utf-8\r\n` +
    `Content-Length: ${body.length}\r\nX-GitHub-Request-Id: r1\r\nConnection: keep-alive\r\n\r\n`;
  const hdrLen = Buffer.byteLength(hdr, 'latin1');
  const frame = Buffer.allocUnsafe(hdrLen + body.length);
  frame.write(hdr, 0, hdrLen, 'latin1');
  body.copy(frame, hdrLen);
  return frame;
}

export function refreshIssueRestCache(issue: IssueRecord, owner: string, ownerJson?: string): void {
  const jsonStr = buildIssueJsonString(issue, owner, ownerJson ?? JSON.stringify(owner));
  const bodyLen = Buffer.byteLength(jsonStr, 'utf8');
  const hdr =
    `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n` +
    `Content-Length: ${bodyLen}\r\nX-GitHub-Request-Id: r1\r\nConnection: keep-alive\r\n\r\n`;
  const hdrLen = Buffer.byteLength(hdr, 'latin1');
  const frame200 = Buffer.allocUnsafe(hdrLen + bodyLen);
  frame200.write(hdr, 0, hdrLen, 'latin1');
  frame200.write(jsonStr, hdrLen, bodyLen, 'utf8');

  issue.restHttp200Frame = frame200;
  issue.restJsonBuf = frame200.subarray(hdrLen);
  issue.restHeaders = [
    'Content-Type',
    'application/json; charset=utf-8',
    'Content-Length',
    String(bodyLen),
    'X-GitHub-Request-Id',
    'r1',
  ];
}

export function serializeRepoRest(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: {
      login: repo.owner,
      id: 1000,
      node_id: 'MDQ6VXNlcjEwMDA=',
      type: 'User',
      site_admin: false,
    },
    html_url: `https://github.com/${repo.full_name}`,
    description: repo.description,
    fork: false,
    default_branch: repo.default_branch,
    has_issues: true,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

export function serializePullRest(repo: RepoRecord, pr: PullRequestRecord): Record<string, unknown> {
  const liveHead =
    pr.state === 'open' ? (repo.git.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha) : pr.headSha;
  const liveBase =
    pr.state === 'open' ? (repo.git.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha) : pr.baseSha;
  return {
    id: pr.id,
    node_id: pr.node_id,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: {
      ref: pr.headRef,
      sha: liveHead,
      label: `${repo.owner}:${pr.headRef}`,
    },
    base: {
      ref: pr.baseRef,
      sha: liveBase,
      label: `${repo.owner}:${pr.baseRef}`,
    },
    merged: pr.merged,
    mergeable: pr.merged ? null : true,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

const EMPTY_BUF = Buffer.alloc(0);

/**
 * 全局 Forge 状态存储
 */
export class ForgeStore {
  nextEntityId = 5000;
  deleteCount = 0;
  viewerLogin: string = process.env.MAKEFUN_SHOP_OWNER || DEFAULT_VIEWER_LOGIN;

  /** key: `${owner}/${repoName}` */
  readonly repos = new Map<string, RepoRecord>();
  readonly reposByNodeId = new Map<string, RepoRecord>();
  readonly issuesByNodeId = new Map<string, { repo: RepoRecord; issue: IssueRecord }>();
  readonly pullsByNodeId = new Map<string, { repo: RepoRecord; pull: PullRequestRecord }>();

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const existing = this.repos.get(key);
    if (!existing) return false;
    this.deleteCount++;
    this.repos.delete(key);
    this.reposByNodeId.delete(existing.node_id);
    for (const issue of existing.issuesList) {
      this.issuesByNodeId.delete(issue.node_id);
    }
    for (const pr of existing.pullsList) {
      this.pullsByNodeId.delete(pr.node_id);
    }
    return true;
  }

  createRepo(opts: {
    owner?: string;
    name: string;
    isPrivate?: boolean;
    description?: string | null;
    defaultBranch?: string;
  }): { created: true; repo: RepoRecord } | { created: false; reason: string } {
    const owner = opts.owner || this.viewerLogin;
    const key = `${owner}/${opts.name}`;
    if (this.repos.has(key)) {
      return { created: false, reason: `Repository ${key} already exists` };
    }
    const id = ++this.nextEntityId;
    const nodeId = encodeNodeId('R', id);
    const defaultBranch = opts.defaultBranch || 'main';
    const { iso } = fastNowIso();
    const git = new GitRepositoryStore();
    git.defaultBranch = defaultBranch;

    const repo: RepoRecord = {
      id,
      node_id: nodeId,
      name: opts.name,
      full_name: key,
      fullNameBuf: Buffer.from(key, 'utf8'),
      owner,
      ownerJson: JSON.stringify(owner),
      private: opts.isPrivate ?? false,
      description: typeof opts.description === 'string' ? opts.description : '',
      default_branch: defaultBranch,
      created_at: iso,
      updated_at: iso,
      git,
      exactCommitMessages: new Map(),
      labels: new Map(),
      issuesList: [],
      issuesByNumber: [undefined],
      nextIssueNumber: 1,
      pullsList: [],
      pullsByNumber: new Map(),
      nextPullNumber: 1,
    };

    this.repos.set(key, repo);
    this.reposByNodeId.set(nodeId, repo);
    return { created: true, repo };
  }

  /** 创建 Issue（带极速快速通道，供 REST POST /issues、GraphQL 与 MCP 共用） */
  createIssue(
    repo: RepoRecord,
    opts: { title: string; body?: string | null; labelNames?: unknown[] },
  ): { ok: true; issue: IssueRecord } | { ok: false; status: number; message: string } {
    const resolvedLabels: LabelItem[] = [];
    if (Array.isArray(opts.labelNames) && opts.labelNames.length > 0) {
      for (const raw of opts.labelNames) {
        const lName =
          typeof raw === 'string'
            ? raw
            : typeof raw === 'object' && raw !== null
              ? String((raw as { name?: unknown }).name ?? '')
              : '';
        const found = repo.labels.get(lName);
        if (!found) {
          return { ok: false, status: 422, message: `Validation Failed: label '${lName}' does not exist` };
        }
        resolvedLabels.push(found);
      }
    }

    const id = ++this.nextEntityId;
    const nodeId = encodeNodeId('I', id);
    const number = repo.nextIssueNumber++;
    const { ms, iso } = fastNowIso();

    const issue: IssueRecord = {
      id,
      node_id: nodeId,
      number,
      title: String(opts.title),
      body: typeof opts.body === 'string' ? opts.body : '',
      state: 'open',
      labels: resolvedLabels,
      comments: [],
      createdAtMs: ms,
      created_at: iso,
      updated_at: iso,
      restJsonBuf: EMPTY_BUF,
      restHttp200Frame: EMPTY_BUF,
      restHeaders: [],
    };
    refreshIssueRestCache(issue, repo.owner, repo.ownerJson);

    repo.issuesList.push(issue);
    repo.issuesByNumber[number] = issue;
    this.issuesByNodeId.set(nodeId, { repo, issue });
    return { ok: true, issue };
  }

  /** 修改 Issue 状态或内容并刷新预序列化缓存 */
  updateIssue(
    repo: RepoRecord,
    issue: IssueRecord,
    patch: { title?: string; body?: string; state?: string },
  ): IssueRecord {
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    if (patch.state === 'closed' || patch.state === 'open') {
      issue.state = patch.state;
    }
    issue.updated_at = fastNowIso().iso;
    refreshIssueRestCache(issue, repo.owner, repo.ownerJson);
    return issue;
  }

  /** 添加 Issue 评论 */
  addComment(repo: RepoRecord, issue: IssueRecord, bodyText: string): CommentRecord {
    const id = ++this.nextEntityId;
    const nodeId = encodeNodeId('C', id);
    const { iso } = fastNowIso();
    const comment: CommentRecord = {
      id,
      node_id: nodeId,
      body: bodyText,
      created_at: iso,
      updated_at: iso,
    };
    issue.comments.push(comment);
    issue.updated_at = iso;
    refreshIssueRestCache(issue, repo.owner, repo.ownerJson);
    return comment;
  }

  /** 解析 ref 名称或 SHA 为具体的 Commit OID */
  resolveRevision(repo: RepoRecord, refOrSha?: string | null): string | null {
    const target = refOrSha && refOrSha.trim() !== '' ? refOrSha.trim() : repo.default_branch;
    if (target.startsWith('refs/')) {
      return repo.git.refs.get(target) ?? null;
    }
    const asHead = repo.git.refs.get(`refs/heads/${target}`);
    if (asHead) return asHead;
    const asTag = repo.git.refs.get(`refs/tags/${target}`);
    if (asTag) return repo.git.peelTag(asTag);
    if (isHex40(target) && repo.git.objects.get(target)?.type === 'commit') {
      return target;
    }
    return null;
  }

  /** REST Contents API: 创建或更新单文件并提交到 Git 对象库 */
  putFileContent(
    repo: RepoRecord,
    rawPath: string,
    opts: { message: string; contentBase64: string; branch?: string; sha?: string },
  ):
    | { ok: true; status: number; fileSha: string; fileSize: number; commitSha: string }
    | { ok: false; status: number; message: string } {
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) {
      return { ok: false, status: 422, message: 'Invalid file path' };
    }
    const branch =
      opts.branch && opts.branch.trim() !== ''
        ? opts.branch.trim().replace(/^refs\/heads\//, '')
        : repo.default_branch;
    const refName = `refs/heads/${branch}`;
    let parentSha = repo.git.refs.get(refName) ?? null;
    if (!parentSha && branch !== repo.default_branch) {
      parentSha = repo.git.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
    }

    const parentTree = parentSha ? (repo.git.getCommit(parentSha)?.tree ?? null) : null;
    const filesMap = repo.git.flattenTree(parentTree);
    const existingSha = filesMap.get(cleanPath);

    if (typeof opts.sha === 'string' && opts.sha.length > 0) {
      if (!existingSha || existingSha.toLowerCase() !== opts.sha.toLowerCase()) {
        return { ok: false, status: 409, message: `${cleanPath} does not match ${opts.sha}` };
      }
    }

    const rawBytes = Buffer.from(opts.contentBase64, 'base64');
    const blobObj = repo.git.putObject('blob', rawBytes);
    filesMap.set(cleanPath, blobObj.oid);

    const newTreeOid = repo.git.buildTreeFromMap(filesMap);
    const msg = opts.message || `Update ${cleanPath}`;
    const commitBuf = encodeCommit({
      tree: newTreeOid,
      parents: parentSha ? [parentSha] : [],
      message: msg,
    });
    const commitObj = repo.git.putObject('commit', commitBuf);
    repo.exactCommitMessages.set(commitObj.oid, msg);
    repo.git.refs.set(refName, commitObj.oid);
    repo.git.bumpVersion();

    return {
      ok: true,
      status: 201,
      fileSha: blobObj.oid,
      fileSize: rawBytes.length,
      commitSha: commitObj.oid,
    };
  }

  /** REST Contents API: 删除单文件并提交到 Git 对象库 */
  deleteFileContent(
    repo: RepoRecord,
    rawPath: string,
    opts: { message: string; sha?: string; branch?: string },
  ): { ok: true; commitSha: string } | { ok: false; status: number; message: string } {
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    const branch =
      opts.branch && opts.branch.trim() !== ''
        ? opts.branch.trim().replace(/^refs\/heads\//, '')
        : repo.default_branch;
    const refName = `refs/heads/${branch}`;
    const parentSha = repo.git.refs.get(refName);
    if (!parentSha) {
      return { ok: false, status: 404, message: 'Branch not found' };
    }

    const parentTree = repo.git.getCommit(parentSha)?.tree ?? null;
    const filesMap = repo.git.flattenTree(parentTree);
    const existingSha = filesMap.get(cleanPath);
    if (!existingSha) {
      return { ok: false, status: 404, message: `${cleanPath} not found` };
    }
    if (typeof opts.sha === 'string' && opts.sha.length > 0 && existingSha.toLowerCase() !== opts.sha.toLowerCase()) {
      return { ok: false, status: 409, message: 'File SHA mismatch' };
    }

    filesMap.delete(cleanPath);
    const newTreeOid = repo.git.buildTreeFromMap(filesMap);
    const msg = opts.message || `Delete ${cleanPath}`;
    const commitBuf = encodeCommit({
      tree: newTreeOid,
      parents: [parentSha],
      message: msg,
    });
    const commitObj = repo.git.putObject('commit', commitBuf);
    repo.exactCommitMessages.set(commitObj.oid, msg);
    repo.git.refs.set(refName, commitObj.oid);
    repo.git.bumpVersion();

    return { ok: true, commitSha: commitObj.oid };
  }

  /** REST Contents API: 读取文件或目录列表 */
  readContentAtPath(
    repo: RepoRecord,
    rawPath: string,
    refParam?: string | null,
  ):
    | { kind: 'file'; data: Record<string, unknown> }
    | { kind: 'dir'; items: Array<Record<string, unknown>> }
    | { kind: 'not_found' } {
    const commitOid = this.resolveRevision(repo, refParam);
    if (!commitOid) return { kind: 'not_found' };
    const commit = repo.git.getCommit(commitOid);
    if (!commit) return { kind: 'not_found' };

    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    const segments = cleanPath === '' ? [] : cleanPath.split('/');
    let curOid = commit.tree;
    let curMode = '40000';

    for (let i = 0; i < segments.length; i++) {
      const entries = repo.git.getTree(curOid);
      if (!entries) return { kind: 'not_found' };
      const match = entries.find((e) => e.name === segments[i]);
      if (!match) return { kind: 'not_found' };
      curOid = match.oid;
      curMode = match.mode;
    }

    if (curMode === '40000') {
      const entries = repo.git.getTree(curOid);
      if (!entries) return { kind: 'not_found' };
      const items = entries.map((e) => {
        const subPath = cleanPath ? `${cleanPath}/${e.name}` : e.name;
        const isDir = e.mode === '40000';
        const size = isDir ? 0 : (repo.git.objects.get(e.oid)?.data.length ?? 0);
        return {
          type: isDir ? 'dir' : 'file',
          name: e.name,
          path: subPath,
          sha: e.oid,
          size,
        };
      });
      return { kind: 'dir', items };
    }

    const blob = repo.git.objects.get(curOid);
    if (!blob) return { kind: 'not_found' };
    const fileName = segments[segments.length - 1] ?? '';
    return {
      kind: 'file',
      data: {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: fileName,
        path: cleanPath,
        content: blob.data.toString('base64'),
        sha: curOid,
      },
    };
  }

  /** 列出从指定分支或提交可达的 Commit 历史 */
  listCommits(repo: RepoRecord, shaOrBranch?: string | null, limit = 100): Array<Record<string, unknown>> | null {
    if (shaOrBranch && shaOrBranch.trim() !== '') {
      const start = this.resolveRevision(repo, shaOrBranch);
      if (!start) return null;
      return this.walkCommitHistory(repo, start, limit);
    }
    const defaultStart = repo.git.refs.get(`refs/heads/${repo.default_branch}`);
    if (!defaultStart) return [];
    return this.walkCommitHistory(repo, defaultStart, limit);
  }

  private walkCommitHistory(repo: RepoRecord, startOid: string, limit: number): Array<Record<string, unknown>> {
    const visited = new Set<string>();
    const queue: string[] = [startOid];
    const result: Array<Record<string, unknown>> = [];

    while (queue.length > 0 && result.length < limit) {
      const oid = queue.shift()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const parsed = repo.git.getCommit(oid);
      if (!parsed) continue;
      const exactMsg = repo.exactCommitMessages.get(oid) ?? parsed.message.replace(/\n$/, '');
      result.push({
        sha: oid,
        commit: {
          message: exactMsg,
          tree: { sha: parsed.tree },
        },
        parents: parsed.parents.map((p) => ({ sha: p })),
      });
      for (const p of parsed.parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
    return result;
  }

  /** 创建 Pull Request（自动去除可能的 owner: 或 refs/heads/ 前缀） */
  createPullRequest(
    repo: RepoRecord,
    opts: { title: string; body?: string | null; head: string; base: string },
  ): { ok: true; pull: PullRequestRecord } | { ok: false; status: number; message: string } {
    const normalizeRef = (raw: string): string => {
      let s = raw.trim();
      const colonIdx = s.indexOf(':');
      if (colonIdx !== -1) s = s.slice(colonIdx + 1);
      return s.replace(/^refs\/heads\//, '');
    };
    const headRef = normalizeRef(opts.head);
    const baseRef = normalizeRef(opts.base);

    const headSha = repo.git.refs.get(`refs/heads/${headRef}`);
    if (!headSha) {
      return { ok: false, status: 422, message: `Validation Failed: head branch '${headRef}' does not exist` };
    }
    const baseSha = repo.git.refs.get(`refs/heads/${baseRef}`);
    if (!baseSha) {
      return { ok: false, status: 422, message: `Validation Failed: base branch '${baseRef}' does not exist` };
    }

    const id = ++this.nextEntityId;
    const nodeId = encodeNodeId('PR', id);
    const number = repo.nextPullNumber++;
    const { ms, iso } = fastNowIso();

    const pr: PullRequestRecord = {
      id,
      node_id: nodeId,
      number,
      state: 'open',
      title: String(opts.title),
      body: typeof opts.body === 'string' ? opts.body : '',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      createdAtMs: ms,
      created_at: iso,
      updated_at: iso,
    };

    repo.pullsList.push(pr);
    repo.pullsByNumber.set(number, pr);
    this.pullsByNodeId.set(nodeId, { repo, pull: pr });
    return { ok: true, pull: pr };
  }

  /** 计算 PR 当前的真实文件变更列表 */
  getPullFiles(repo: RepoRecord, pr: PullRequestRecord): ChangedFileDiff[] {
    if (pr.merged && pr.merge_commit_sha) {
      const mergeCommit = repo.git.getCommit(pr.merge_commit_sha);
      if (mergeCommit && mergeCommit.parents.length >= 2) {
        return repo.git.diffCommits(mergeCommit.parents[0]!, pr.merge_commit_sha);
      }
    }
    const liveHead =
      pr.state === 'open' ? (repo.git.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha) : pr.headSha;
    const liveBase =
      pr.state === 'open' ? (repo.git.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha) : pr.baseSha;
    return repo.git.diffCommits(liveBase, liveHead);
  }

  /** 合并 Pull Request（支持 merge / squash / rebase 三种策略，真实提交进 Git 仓库） */
  mergePullRequest(
    repo: RepoRecord,
    pr: PullRequestRecord,
    optsOrMethod?: { mergeMethod?: string; commitTitle?: string; commitMessage?: string } | string,
    commitTitleArg?: string,
  ):
    | { ok: true; sha: string; message: string; pull: PullRequestRecord }
    | { ok: false; status: number; message: string } {
    const opts: { mergeMethod?: string; commitTitle?: string; commitMessage?: string } =
      typeof optsOrMethod === 'string'
        ? { mergeMethod: optsOrMethod, commitTitle: commitTitleArg }
        : optsOrMethod ?? {};
    if (pr.merged) {
      return { ok: false, status: 405, message: 'Pull Request is already merged' };
    }
    if (pr.state !== 'open') {
      return { ok: false, status: 405, message: 'Pull Request is closed' };
    }

    const headRefKey = `refs/heads/${pr.headRef}`;
    const baseRefKey = `refs/heads/${pr.baseRef}`;
    const currentHeadSha = repo.git.refs.get(headRefKey) ?? pr.headSha;
    const currentBaseSha = repo.git.refs.get(baseRefKey) ?? pr.baseSha;

    const method = (opts.mergeMethod || 'merge').toLowerCase();
    const mergedTreeOid = repo.git.threeWayMergeTrees(currentBaseSha, currentHeadSha);
    if (mergedTreeOid === null) {
      return { ok: false, status: 405, message: 'Merge conflict: cannot cleanly merge head into base' };
    }

    let finalSha: string;
    const defaultMsg =
      opts.commitTitle ||
      opts.commitMessage ||
      `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;

    if (method === 'squash') {
      const msg = opts.commitTitle || opts.commitMessage || `${pr.title} (#${pr.number})`;
      const cBuf = encodeCommit({
        tree: mergedTreeOid,
        parents: [currentBaseSha],
        message: msg,
      });
      finalSha = repo.git.putObject('commit', cBuf).oid;
      repo.exactCommitMessages.set(finalSha, msg);
    } else if (method === 'rebase') {
      const lca = repo.git.findMergeBase(currentBaseSha, currentHeadSha);
      const commitsToReplay = repo.git.collectExclusiveHistory(currentHeadSha, lca);
      if (commitsToReplay.length === 0) {
        finalSha = currentBaseSha;
      } else {
        let curBase = currentBaseSha;
        for (const origOid of commitsToReplay) {
          const orig = repo.git.getCommit(origOid)!;
          const rebasedTree = repo.git.threeWayMergeTrees(curBase, origOid);
          if (rebasedTree === null) {
            return { ok: false, status: 409, message: 'Merge conflict during rebase' };
          }
          const origMsg = repo.exactCommitMessages.get(origOid) ?? orig.message.replace(/\n$/, '');
          const cBuf = encodeCommit({
            tree: rebasedTree,
            parents: [curBase],
            message: origMsg,
          });
          curBase = repo.git.putObject('commit', cBuf).oid;
          repo.exactCommitMessages.set(curBase, origMsg);
        }
        finalSha = curBase;
      }
    } else {
      const cBuf = encodeCommit({
        tree: mergedTreeOid,
        parents: [currentBaseSha, currentHeadSha],
        message: defaultMsg,
      });
      finalSha = repo.git.putObject('commit', cBuf).oid;
      repo.exactCommitMessages.set(finalSha, defaultMsg);
    }

    repo.git.refs.set(baseRefKey, finalSha);
    repo.git.bumpVersion();

    const { iso } = fastNowIso();
    pr.headSha = currentHeadSha;
    pr.baseSha = currentBaseSha;
    pr.merged = true;
    pr.state = 'closed';
    pr.merged_at = iso;
    pr.merge_commit_sha = finalSha;
    pr.updated_at = iso;

    return { ok: true, sha: finalSha, message: 'Pull Request successfully merged', pull: pr };
  }
}
