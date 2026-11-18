/**
 * Git Forge 统一存储层与预序列化实体模型 (v2.0.0)
 *
 * 将 Git 底层对象库与 REST v3 / GraphQL v4 / MCP 资源视图实时联动，
 * 并对高频访问的 Issue 实体实施预序列化 Buffer 缓存。
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
  /** 预序列化的精简合规 REST JSON Buffer（使 read 压测零 JSON.stringify） */
  restJsonBuf: Buffer;
  /** 预编译的零拷贝 HTTP 响应头数组（消除 writeHead 时的对象分配与字符串化） */
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
  owner: string;
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

export function buildIssueRestBuffer(issue: IssueRecord, owner: string): Buffer {
  if (issue.labels.length === 0) {
    const fastJson =
      `{"id":${issue.id},"node_id":"${issue.node_id}","number":${issue.number},` +
      `"title":${JSON.stringify(issue.title)},"body":${JSON.stringify(issue.body)},` +
      `"state":"${issue.state}","labels":[],"comments":${issue.comments.length},` +
      `"user":{"login":${JSON.stringify(owner)},"id":1000,"type":"User"},` +
      `"created_at":"${issue.created_at}","updated_at":"${issue.updated_at}"}`;
    return Buffer.from(fastJson, 'utf8');
  }
  const payload = {
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
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export function refreshIssueRestCache(issue: IssueRecord, owner: string): void {
  const buf = buildIssueRestBuffer(issue, owner);
  issue.restJsonBuf = buf;
  issue.restHeaders = [
    'Content-Type',
    'application/json; charset=utf-8',
    'Content-Length',
    String(buf.length),
    'X-GitHub-Request-Id',
    '1',
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
  // 如果 PR 仍处于 open 状态，同步反映当前分支最新 tip（如存在）
  const liveHead = pr.state === 'open' ? (repo.git.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha) : pr.headSha;
  const liveBase = pr.state === 'open' ? (repo.git.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha) : pr.baseSha;
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

/**
 * 全局 Forge 状态存储
 */
export class ForgeStore {
  nextEntityId = 5000;
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
      owner,
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
        const lName = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? String((raw as { name?: unknown }).name ?? '') : '';
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
      restJsonBuf: Buffer.alloc(0),
      restHeaders: [],
    };
    refreshIssueRestCache(issue, repo.owner);

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
    refreshIssueRestCache(issue, repo.owner);
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
    refreshIssueRestCache(issue, repo.owner);
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
  ): { ok: true; status: number; fileSha: string; fileSize: number; commitSha: string } | { ok: false; status: number; message: string } {
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) {
      return { ok: false, status: 422, message: 'Invalid file path' };
    }
    const branch = opts.branch && opts.branch.trim() !== '' ? opts.branch.trim().replace(/^refs\/heads\//, '') : repo.default_branch;
    const refName = `refs/heads/${branch}`;
    let parentSha = repo.git.refs.get(refName) ?? null;
    if (!parentSha && branch !== repo.default_branch) {
      // 若指定的新分支不存在但默认分支已有提交，则基于默认分支派生
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
    const branch = opts.branch && opts.branch.trim() !== '' ? opts.branch.trim().replace(/^refs\/heads\//, '') : repo.default_branch;
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
    const normalizeRef = (r: string): string => {
      let clean = r.trim();
      if (clean.startsWith(`${repo.owner}:`)) clean = clean.slice(repo.owner.length + 1);
      if (clean.startsWith('refs/heads/')) clean = clean.slice('refs/heads/'.length);
      return clean;
    };

    const headRef = normalizeRef(opts.head);
    const baseRef = normalizeRef(opts.base);
    const headSha = repo.git.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.git.refs.get(`refs/heads/${baseRef}`);

    if (!headSha) {
      return { ok: false, status: 422, message: `Invalid head branch: ${headRef}` };
    }
    if (!baseSha) {
      return { ok: false, status: 422, message: `Invalid base branch: ${baseRef}` };
    }

    const id = ++this.nextEntityId;
    const nodeId = encodeNodeId('PR', id);
    const number = repo.nextPullNumber++;
    const { ms, iso } = fastNowIso();

    const pull: PullRequestRecord = {
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

    repo.pullsList.push(pull);
    repo.pullsByNumber.set(number, pull);
    this.pullsByNodeId.set(nodeId, { repo, pull });
    return { ok: true, pull };
  }

  /** 计算 PR 变更文件列表 */
  getPullFiles(repo: RepoRecord, pull: PullRequestRecord): ChangedFileDiff[] {
    const headSha = pull.state === 'open' ? (repo.git.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha) : pull.headSha;
    const baseSha = pull.baseSha;
    return repo.git.diffCommits(baseSha, headSha);
  }

  /** 合并 Pull Request（更新真实 Git 分支与 Commit 历史，冲突返回 405） */
  mergePullRequest(
    repo: RepoRecord,
    pull: PullRequestRecord,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge',
    commitTitle?: string,
  ): { ok: true; sha: string; pull: PullRequestRecord } | { ok: false; status: number; message: string } {
    if (pull.merged || pull.state !== 'open') {
      return { ok: false, status: 405, message: 'Pull Request is already closed or merged' };
    }

    const currentHead = repo.git.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const currentBase = repo.git.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    pull.headSha = currentHead;
    pull.baseSha = currentBase;

    const merged = repo.git.mergeBranches(
      pull.baseRef,
      pull.headRef,
      mergeMethod,
      commitTitle || `${pull.title} (#${pull.number})`,
    );
    if (!merged.ok) {
      return { ok: false, status: 405, message: merged.reason };
    }

    const { iso } = fastNowIso();
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = iso;
    pull.merge_commit_sha = merged.commitSha;
    pull.updated_at = iso;

    return { ok: true, sha: merged.commitSha, pull };
  }
}
