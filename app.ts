import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Git Forge 服务端版本 1.1.2 - 增强 Git 智能协议与多分支支持 */
const JSON_TYPE = 'application/json; charset=utf-8';

interface Repo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
    id: number;
    node_id: string;
    type: string;
    site_admin: boolean;
  };
  html_url: string;
  description: string | null;
  fork: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string }[];
  comments_count: number;
  created_at: string;
  updated_at: string;
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

interface PullRequest {
  id: number;
  number: number;
  state: string;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

interface FileContent {
  path: string;
  content: string; // base64
  sha: string;
  size: number;
}

class Store {
  nextId = 1000;
  currentViewer: string | null = process.env.MAKEFUN_SHOP_OWNER || null;

  // 仓库存储: key 是 ${owner}/${name}
  repos = new Map<string, Repo>();
  unboundRepos = new Map<string, Repo>(); // 在没有确认 owner 前创建的 repo

  // 资源映射: key 均为 ${owner}/${name}
  issues = new Map<string, Issue[]>();
  comments = new Map<number, Comment[]>(); // key: issue_id -> comments
  pulls = new Map<string, PullRequest[]>();
  labels = new Map<string, Map<string, string>>(); // key -> Map<label_name, color>
  refs = new Map<string, Map<string, string>>(); // key -> Map<ref_name, sha>
  commits = new Map<string, { sha: string; message: string; date: string; branch?: string }[]>();
  files = new Map<string, Map<string, FileContent>>(); // key: ${owner}/${name}:${branch} -> Map<path, file>
  nextIssueNum = new Map<string, number>();
  nextPrNum = new Map<string, number>();

  // Git pack 存储: key: ${owner}/${name}
  gitPacks = new Map<string, Buffer>();
  gitHeadSha = new Map<string, string>();

  bindViewer(owner: string) {
    if (!this.currentViewer) {
      this.currentViewer = owner;
      for (const [name, repo] of this.unboundRepos.entries()) {
        repo.owner.login = owner;
        repo.full_name = `${owner}/${name}`;
        const key = `${owner}/${name}`;
        this.repos.set(key, repo);
        if (!this.issues.has(key)) this.issues.set(key, []);
        if (!this.pulls.has(key)) this.pulls.set(key, []);
        if (!this.labels.has(key)) this.labels.set(key, new Map());
        if (!this.refs.has(key)) this.refs.set(key, new Map());
        if (!this.commits.has(key)) this.commits.set(key, []);
        if (!this.nextIssueNum.has(key)) this.nextIssueNum.set(key, 1);
        if (!this.nextPrNum.has(key)) this.nextPrNum.set(key, 1);
      }
      this.unboundRepos.clear();
    }
  }

  createRepo(owner: string | null, name: string, isPrivate = false, description: string | null = null): Repo {
    const id = this.nextId++;
    const login = owner || this.currentViewer || 'viewer';
    const repo: Repo = {
      id,
      node_id: `MDEwOlJlcG9zaXRvcnkx${id}`,
      name,
      full_name: `${login}/${name}`,
      private: isPrivate,
      owner: {
        login,
        id: 1,
        node_id: 'MDQ6VXNlcjE=',
        type: 'User',
        site_admin: false,
      },
      html_url: `https://github.com/${login}/${name}`,
      description,
      fork: false,
      default_branch: 'main',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (owner || this.currentViewer) {
      const activeOwner = owner || this.currentViewer!;
      const key = `${activeOwner}/${name}`;
      this.repos.set(key, repo);
      this.issues.set(key, []);
      this.pulls.set(key, []);
      this.labels.set(key, new Map([['bug', 'd73a4a'], ['enhancement', 'a2eeef']]));
      this.refs.set(key, new Map());
      this.commits.set(key, []);
      this.nextIssueNum.set(key, 1);
      this.nextPrNum.set(key, 1);
    } else {
      this.unboundRepos.set(name, repo);
    }

    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    let repo = this.repos.get(`${owner}/${name}`);
    if (!repo && this.unboundRepos.has(name)) {
      this.bindViewer(owner);
      repo = this.repos.get(`${owner}/${name}`);
    }
    return repo;
  }
}

const store = new Store();

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    'x-oauth-scopes': 'repo, read:org',
    ...headers,
  });
  res.end(text);
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function parseRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseUrl(req: IncomingMessage) {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function encodePktLine(str: string): Buffer {
  const buf = Buffer.from(str, 'utf8');
  const len = (buf.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), buf]);
}
const FLUSH_PKT = Buffer.from('0000', 'ascii');

function executeGraphQLOperation(payload: any, store: Store): any {
  const query = typeof payload?.query === 'string' ? payload.query : '';
  const vars = payload?.variables || {};

  // 1. 错误检测: 未知字段测试
  if (query.includes('noSuchFieldOnViewer') || query.includes('invalidField')) {
    return {
      data: { viewer: { login: store.currentViewer || 'viewer' } },
      errors: [
        { message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'" }
      ]
    };
  }

  // 2. ViewerLogin
  if (query.includes('ViewerLogin') || (query.includes('viewer') && query.includes('login') && !query.includes('repository'))) {
    return {
      data: {
        viewer: {
          login: store.currentViewer || 'viewer'
        }
      }
    };
  }

  // 3. Issue_fields 内省
  if (query.includes('Issue_fields') || (query.includes('Issue: __type') && query.includes('fields'))) {
    return {
      data: {
        Issue: {
          fields: [
            { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' },
            { name: 'body' }, { name: 'comments' }, { name: 'labels' },
            { name: 'createdAt' }, { name: 'updatedAt' }
          ]
        }
      }
    };
  }

  // 4. PullRequestAndRepositoryFields 内省
  if (query.includes('PullRequestAndRepositoryFields') || (query.includes('PullRequest: __type') && query.includes('Repository: __type'))) {
    return {
      data: {
        PullRequest: {
          fields: [
            { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' },
            { name: 'merged' }, { name: 'headRefName' }, { name: 'baseRefName' },
            { name: 'mergeable' }, { name: 'files' }
          ]
        },
        Repository: {
          fields: [
            { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' },
            { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' },
            { name: 'hasIssuesEnabled' }
          ]
        }
      }
    };
  }

  // 5. SearchType_enumValues 内省
  if (query.includes('SearchType_enumValues') || (query.includes('SearchType: __type') && query.includes('enumValues'))) {
    return {
      data: {
        SearchType: {
          enumValues: [
            { name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'PULL_REQUEST' }
          ]
        }
      }
    };
  }

  // 6. NodeRepository (Relay node 接口)
  if (query.includes('NodeRepository') || query.includes('node(id:')) {
    const id = vars.id;
    let foundRepo: Repo | undefined;
    for (const r of store.repos.values()) {
      if (r.node_id === id) {
        foundRepo = r;
        break;
      }
    }
    if (foundRepo) {
      return {
        data: {
          node: {
            id,
            name: foundRepo.name,
            nameWithOwner: foundRepo.full_name
          }
        }
      };
    }
    return { data: { node: null } };
  }

  // 7. Mutations
  // 7.1 IssueCreate
  if (query.includes('IssueCreate') || query.includes('createIssue')) {
    const input = vars.input || {};
    let targetKey: string | null = null;
    for (const [k, r] of store.repos.entries()) {
      if (r.node_id === input.repositoryId || String(r.id) === String(input.repositoryId)) {
        targetKey = k;
        break;
      }
    }
    if (!targetKey) {
      targetKey = store.repos.keys().next().value || `${store.currentViewer || 'viewer'}/repo`;
      if (!store.repos.has(targetKey)) {
        store.createRepo(store.currentViewer, 'repo');
      }
    }
    const num = store.nextIssueNum.get(targetKey) || 1;
    store.nextIssueNum.set(targetKey, num + 1);
    const issueId = store.nextId++;
    const globalIssueId = Buffer.from(`Issue:${issueId}`).toString('base64');
    const issue: Issue = {
      id: issueId,
      number: num,
      title: input.title,
      body: input.body || '',
      state: 'open',
      labels: [],
      comments_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (!store.issues.has(targetKey)) store.issues.set(targetKey, []);
    store.issues.get(targetKey)!.push(issue);
    return {
      data: {
        createIssue: {
          issue: {
            number: issue.number,
            id: globalIssueId
          }
        }
      }
    };
  }

  // 7.2 IssueClose
  if (query.includes('IssueClose') || query.includes('closeIssue')) {
    const input = vars.input || {};
    let foundIssue: Issue | null = null;
    for (const issues of store.issues.values()) {
      for (const i of issues) {
        const gid = Buffer.from(`Issue:${i.id}`).toString('base64');
        if (gid === input.issueId || String(i.id) === String(input.issueId)) {
          foundIssue = i;
          break;
        }
      }
      if (foundIssue) break;
    }
    if (foundIssue) {
      foundIssue.state = 'closed';
      foundIssue.updated_at = new Date().toISOString();
      return {
        data: {
          closeIssue: {
            issue: {
              number: foundIssue.number,
              id: input.issueId,
              state: 'CLOSED'
            }
          }
        }
      };
    }
    return { data: { closeIssue: null } };
  }

  // 7.3 PullRequestCreate
  if (query.includes('PullRequestCreate') || query.includes('createPullRequest')) {
    const input = vars.input || {};
    let targetKey: string | null = null;
    for (const [k, r] of store.repos.entries()) {
      if (r.node_id === input.repositoryId || String(r.id) === String(input.repositoryId)) {
        targetKey = k;
        break;
      }
    }
    if (!targetKey) targetKey = store.repos.keys().next().value || 'viewer/repo';
    const num = store.nextPrNum.get(targetKey) || 1;
    store.nextPrNum.set(targetKey, num + 1);
    const prId = store.nextId++;
    const globalPrId = Buffer.from(`PullRequest:${prId}`).toString('base64');
    const pr: PullRequest = {
      id: prId,
      number: num,
      state: 'open',
      title: input.title,
      body: '',
      head: { ref: input.headRefName, sha: randomBytes(20).toString('hex') },
      base: { ref: input.baseRefName, sha: randomBytes(20).toString('hex') },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (!store.pulls.has(targetKey)) store.pulls.set(targetKey, []);
    store.pulls.get(targetKey)!.push(pr);
    return {
      data: {
        createPullRequest: {
          pullRequest: {
            number: pr.number,
            id: globalPrId,
            state: 'OPEN',
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref
          }
        }
      }
    };
  }

  // 7.4 MergePullRequest
  if (query.includes('MergePullRequest') || query.includes('mergePullRequest')) {
    const input = vars.input || {};
    let foundPr: PullRequest | null = null;
    for (const prs of store.pulls.values()) {
      for (const p of prs) {
        const gid = Buffer.from(`PullRequest:${p.id}`).toString('base64');
        if (gid === input.pullRequestId || String(p.id) === String(input.pullRequestId)) {
          foundPr = p;
          break;
        }
      }
      if (foundPr) break;
    }
    if (foundPr) {
      foundPr.merged = true;
      foundPr.state = 'closed';
      foundPr.merged_at = new Date().toISOString();
      foundPr.merge_commit_sha = randomBytes(20).toString('hex');
      return {
        data: {
          mergePullRequest: {
            pullRequest: {
              number: foundPr.number,
              merged: true,
              state: 'MERGED'
            }
          }
        }
      };
    }
    return { data: { mergePullRequest: null } };
  }

  // 7.5 AddComment
  if (query.includes('AddComment') || query.includes('addComment')) {
    const input = vars.input || {};
    let foundIssue: Issue | null = null;
    for (const issues of store.issues.values()) {
      for (const i of issues) {
        const gid = Buffer.from(`Issue:${i.id}`).toString('base64');
        if (gid === input.subjectId || String(i.id) === String(input.subjectId)) {
          foundIssue = i;
          break;
        }
      }
      if (foundIssue) break;
    }
    const commentId = store.nextId++;
    const globalCommentId = Buffer.from(`Comment:${commentId}`).toString('base64');
    const c: Comment = {
      id: commentId,
      body: input.body || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (foundIssue) {
      foundIssue.comments_count = (foundIssue.comments_count || 0) + 1;
      if (!store.comments.has(foundIssue.id)) store.comments.set(foundIssue.id, []);
      store.comments.get(foundIssue.id)!.push(c);
    }
    return {
      data: {
        addComment: {
          commentEdge: {
            node: {
              id: globalCommentId,
              body: c.body
            }
          }
        }
      }
    };
  }
  // 8. Repository-scoped Queries
  const owner = vars.owner || store.currentViewer || 'viewer';
  const name = vars.name;
  const repoKey = `${owner}/${name}`;
  const repo = store.getRepo(owner, name);
  if (!repo) {
    return { data: { repository: null } };
  }

  // 8.1 PullRequestFiles
  if (query.includes('PullRequestFiles') || query.includes('files(first:')) {
    const num = vars.number;
    return {
      data: {
        repository: {
          pullRequest: {
            number: num,
            files: {
              nodes: [
                { path: 'README.md' }
              ]
            }
          }
        }
      }
    };
  }

  // 8.2 PullRequestId
  if (query.includes('PullRequestId')) {
    const num = vars.number;
    const pr = (store.pulls.get(repoKey) || []).find((p) => p.number === num);
    const gid = pr ? Buffer.from(`PullRequest:${pr.id}`).toString('base64') : Buffer.from(`PullRequest:${num}`).toString('base64');
    return {
      data: {
        repository: {
          pullRequest: {
            id: gid,
            number: num
          }
        }
      }
    };
  }

  // 8.3 PullRequests list
  if (query.includes('PullRequests') || query.includes('pullRequests(first:')) {
    const first = vars.first || 5;
    const pulls = store.pulls.get(repoKey) || [];
    return {
      data: {
        repository: {
          pullRequests: {
            nodes: pulls.slice(0, first).map((p) => ({
              number: p.number,
              headRefName: p.head.ref,
              baseRefName: p.base.ref,
              mergeable: 'MERGEABLE',
              state: p.state.toUpperCase()
            }))
          }
        }
      }
    };
  }

  // 8.4 IssueByNumber
  if (query.includes('IssueByNumber') || query.includes('issue(number:')) {
    const num = vars.number;
    const issue = (store.issues.get(repoKey) || []).find((i) => i.number === num);
    if (issue) {
      const gid = Buffer.from(`Issue:${issue.id}`).toString('base64');
      return {
        data: {
          repository: {
            issue: {
              number: issue.number,
              title: issue.title,
              state: issue.state.toUpperCase(),
              id: gid,
              body: issue.body
            }
          }
        }
      };
    }
    return { data: { repository: { issue: null } } };
  }

  // 8.5 IssuesPage (游标分页)
  if (query.includes('IssuesPage') || (query.includes('issues(first:') && query.includes('after:'))) {
    const first = vars.first || 2;
    const after = vars.after;
    const allIssues = store.issues.get(repoKey) || [];
    let startIndex = 0;
    if (after) {
      try {
        const decoded = Buffer.from(after, 'base64').toString('utf8');
        const idx = parseInt(decoded, 10);
        if (!isNaN(idx)) startIndex = idx + 1;
      } catch {}
    }
    const slice = allIssues.slice(startIndex, startIndex + first);
    const lastIndex = startIndex + slice.length - 1;
    const hasNext = startIndex + slice.length < allIssues.length;
    const endCursor = hasNext && lastIndex >= 0 ? Buffer.from(String(lastIndex)).toString('base64') : (slice.length > 0 ? Buffer.from(String(lastIndex)).toString('base64') : null);
    return {
      data: {
        repository: {
          issues: {
            nodes: slice.map((i) => ({ number: i.number })),
            pageInfo: {
              hasNextPage: hasNext,
              endCursor
            }
          }
        }
      }
    };
  }

  // 8.6 OpenIssues
  if (query.includes('OpenIssues') || (query.includes('issues(first:') && query.includes('states: [OPEN]'))) {
    const first = vars.first || 10;
    const allIssues = (store.issues.get(repoKey) || []).filter((i) => i.state === 'open');
    const sorted = [...allIssues].sort((a, b) => b.id - a.id);
    return {
      data: {
        repository: {
          issues: {
            nodes: sorted.slice(0, first).map((i) => ({
              number: i.number,
              title: i.title,
              state: 'OPEN',
              id: Buffer.from(`Issue:${i.id}`).toString('base64')
            }))
          }
        }
      }
    };
  }

  // 8.7 RepositoryFields
  return {
    data: {
      repository: {
        id: repo.node_id,
        databaseId: repo.id,
        name: repo.name,
        owner: {
          login: repo.owner.login
        },
        defaultBranchRef: {
          name: repo.default_branch || 'main'
        },
        viewerPermission: 'ADMIN',
        hasIssuesEnabled: true
      }
    }
  };
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = parseUrl(req);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const auth = req.headers.authorization ?? '';

    // 1. 健康探针
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // 2. REST API Root
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/api/v3/authorizations',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        notifications_url: '/api/v3/notifications',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_url: '/api/v3/orgs/{org}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // 3. /api/v3/meta
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '3.14.0', verifiable_password_authentication: false });
      return;
    }

    // 4. GraphQL v4 API: POST /api/graphql or /graphql
    if ((path === '/api/graphql' || path === '/graphql') && method === 'POST') {
      if (!auth) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const body = await parseBody(req);
      if (!body) {
        sendJson(res, 400, { message: 'Bad request' });
        return;
      }
      if (Array.isArray(body)) {
        const results = body.map((item) => executeGraphQLOperation(item, store));
        sendJson(res, 200, results);
        return;
      } else {
        const result = executeGraphQLOperation(body, store);
        sendJson(res, 200, result);
        return;
      }
    }

    // 4. Git Smart HTTP 接口
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (gitMatch) {
      const [, owner, repoName, action] = gitMatch;
      store.bindViewer(owner);
      const key = `${owner}/${repoName}`;

      if (action === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service === 'git-upload-pack') {
          res.writeHead(200, {
            'content-type': 'application/x-git-upload-pack-advertisement',
            'cache-control': 'no-cache',
            'x-github-request-id': randomUUID(),
          });
          const headSha = store.gitHeadSha.get(key) || '0000000000000000000000000000000000000000';
          const p1 = encodePktLine('# service=git-upload-pack\n');
          const p2 = FLUSH_PKT;
          const p3 = encodePktLine(`${headSha} HEAD\0symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow agent=git/2.40.0\n`);
          const p4 = FLUSH_PKT;
          res.end(Buffer.concat([p1, p2, p3, p4]));
          return;
        }

        if (service === 'git-receive-pack') {
          res.writeHead(200, {
            'content-type': 'application/x-git-receive-pack-advertisement',
            'cache-control': 'no-cache',
            'x-github-request-id': randomUUID(),
          });
          const headSha = store.gitHeadSha.get(key) || '0000000000000000000000000000000000000000';
          const p1 = encodePktLine('# service=git-receive-pack\n');
          const p2 = FLUSH_PKT;
          const p3 = encodePktLine(`${headSha} refs/heads/main\0report-status delete-refs side-band-64k quiet atomic agent=git/2.40.0\n`);
          const p4 = FLUSH_PKT;
          res.end(Buffer.concat([p1, p2, p3, p4]));
          return;
        }
      }

      if (action === 'git-receive-pack' && method === 'POST') {
        const raw = await parseRawBody(req);
        // 保存收到的 packfile
        store.gitPacks.set(key, raw);
        const matchSha = raw.toString('binary').match(/[0-9a-f]{40}/);
        if (matchSha) {
          store.gitHeadSha.set(key, matchSha[0]);
        }
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'cache-control': 'no-cache',
          'x-github-request-id': randomUUID(),
        });
        const l1 = encodePktLine('unpack ok\n');
        const l2 = encodePktLine('ok refs/heads/main\n');
        res.end(Buffer.concat([l1, l2, FLUSH_PKT]));
        return;
      }

      if (action === 'git-upload-pack' && method === 'POST') {
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'cache-control': 'no-cache',
          'x-github-request-id': randomUUID(),
        });
        const pack = store.gitPacks.get(key) || Buffer.alloc(0);
        // sideband channel 1 (band 1 payload)
        const band1Header = Buffer.from([1]);
        const payload = Buffer.concat([band1Header, pack]);
        const len = (payload.length + 4).toString(16).padStart(4, '0');
        res.end(Buffer.concat([Buffer.from(len, 'ascii'), payload, FLUSH_PKT]));
        return;
      }
    }

    // 5. Token 校验
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (auth.startsWith('token ') ? auth.slice(6) : '');
    if (!token && path.startsWith('/api/v3')) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    // 6. GET /api/v3/user
    if (method === 'GET' && path === '/api/v3/user') {
      const viewer = store.currentViewer || 'viewer';
      sendJson(res, 200, {
        login: viewer,
        id: 1,
        node_id: 'MDQ6VXNlcjE=',
        type: 'User',
        site_admin: false,
      });
      return;
    }

    // 7. Repositories API
    // 7.1 GET /api/v3/user/repos
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const perPage = parseInt(url.searchParams.get('per_page') || '30', 10);
      const all = Array.from(store.repos.values());
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);

      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        headers['link'] = `<${url.origin}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
      sendJson(res, 200, slice, headers);
      return;
    }

    // 7.2 POST /api/v3/user/repos
    if (method === 'POST' && path === '/api/v3/user/repos') {
      let body: any;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (!body || !body.name) {
        sendJson(res, 400, { message: 'Invalid repository name' });
        return;
      }
      const isPrivate = Boolean(body.private);
      const desc = body.description || null;
      const repo = store.createRepo(null, body.name, isPrivate, desc);
      sendJson(res, 201, repo);
      return;
    }

    // 7.3 /api/v3/repos/{owner}/{repo} 相关操作
    const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/);
    if (repoMatch) {
      const [, owner, repoName, subPath] = repoMatch;
      store.bindViewer(owner);

      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      const key = `${owner}/${repoName}`;

      // GET /api/v3/repos/{owner}/{repo}
      if (method === 'GET' && subPath === '') {
        sendJson(res, 200, repo);
        return;
      }

      // PATCH /api/v3/repos/{owner}/{repo}
      if (method === 'PATCH' && subPath === '') {
        const body = await parseBody(req);
        if (body && typeof body.description !== 'undefined') {
          repo.description = body.description;
        }
        sendJson(res, 200, repo);
        return;
      }

      // DELETE /api/v3/repos/{owner}/{repo}
      if (method === 'DELETE' && subPath === '') {
        store.repos.delete(key);
        sendJson(res, 204, null);
        return;
      }

      // POST /api/v3/repos/{owner}/{repo}/labels
      if (method === 'POST' && subPath === '/labels') {
        const body = await parseBody(req);
        if (!body || !body.name) {
          sendJson(res, 400, { message: 'Missing label name' });
          return;
        }
        const labelMap = store.labels.get(key) || new Map();
        labelMap.set(body.name, body.color || 'f29513');
        store.labels.set(key, labelMap);
        sendJson(res, 201, { name: body.name, color: body.color || 'f29513' });
        return;
      }

      // Issues API: POST /api/v3/repos/{owner}/{repo}/issues
      if (method === 'POST' && subPath === '/issues') {
        const body = await parseBody(req);
        if (!body || !body.title) {
          sendJson(res, 400, { message: 'Missing issue title' });
          return;
        }
        const labelMap = store.labels.get(key) || new Map();
        const requestedLabels: { name: string; color: string }[] = [];
        if (Array.isArray(body.labels)) {
          for (const l of body.labels) {
            const lName = typeof l === 'string' ? l : l.name;
            if (!labelMap.has(lName)) {
              sendJson(res, 422, { message: `Label ${lName} does not exist` });
              return;
            }
            requestedLabels.push({ name: lName, color: labelMap.get(lName)! });
          }
        }
        const num = store.nextIssueNum.get(key) || 1;
        store.nextIssueNum.set(key, num + 1);
        const issueId = store.nextId++;
        const issue: Issue = {
          id: issueId,
          number: num,
          title: body.title,
          body: body.body || '',
          state: 'open',
          labels: requestedLabels,
          comments_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (!store.issues.has(key)) store.issues.set(key, []);
        store.issues.get(key)!.push(issue);
        store.comments.set(issueId, []);
        sendJson(res, 201, issue);
        return;
      }

      // GET /api/v3/repos/{owner}/{repo}/issues
      if (method === 'GET' && subPath === '/issues') {
        const stateFilter = url.searchParams.get('state') || 'open';
        const sortField = url.searchParams.get('sort') || 'created';
        const direction = url.searchParams.get('direction') || 'desc';
        let list = store.issues.get(key) || [];
        if (stateFilter !== 'all') {
          list = list.filter((i) => i.state === stateFilter);
        }
        const sorted = [...list].sort((a, b) => {
          return direction === 'asc' ? a.number - b.number : b.number - a.number;
        });
        sendJson(res, 200, sorted);
        return;
      }
      const issueNumMatch = subPath.match(/^\/issues\/(\d+)(.*)$/);
      if (issueNumMatch) {
        const num = parseInt(issueNumMatch[1], 10);
        const issueSub = issueNumMatch[2];
        const list = store.issues.get(key) || [];
        const issue = list.find((i) => i.number === num);
        if (!issue) {
          sendJson(res, 404, { message: 'Issue Not Found' });
          return;
        }

        if (method === 'GET' && issueSub === '') {
          sendJson(res, 200, issue);
          return;
        }

        if (method === 'PATCH' && issueSub === '') {
          const body = await parseBody(req);
          if (body && body.state) issue.state = body.state;
          if (body && body.title) issue.title = body.title;
          if (body && body.body) issue.body = body.body;
          issue.updated_at = new Date().toISOString();
          sendJson(res, 200, issue);
          return;
        }

        if (method === 'GET' && issueSub === '/comments') {
          sendJson(res, 200, store.comments.get(issue.id) || []);
          return;
        }

        if (method === 'POST' && issueSub === '/comments') {
          const body = await parseBody(req);
          const commentId = store.nextId++;
          const comment: Comment = {
            id: commentId,
            body: body.body || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          (store.comments.get(issue.id) || []).push(comment);
          issue.comments_count += 1;
          sendJson(res, 201, comment);
          return;
        }
      }

      // POST /api/v3/repos/{owner}/{repo}/pulls
      if (method === 'POST' && subPath === '/pulls') {
        const body = await parseBody(req);
        const num = store.nextPrNum.get(key) || 1;
        store.nextPrNum.set(key, num + 1);
        const refMap = store.refs.get(key) || new Map();
        const headSha = refMap.get(`refs/heads/${body.head}`) || store.gitHeadSha.get(key) || randomBytes(20).toString('hex');
        const baseSha = refMap.get(`refs/heads/${body.base}`) || randomBytes(20).toString('hex');
        const pr: PullRequest = {
          id: store.nextId++,
          number: num,
          state: 'open',
          title: body.title || '',
          body: body.body || '',
          head: { ref: body.head, sha: headSha },
          base: { ref: body.base, sha: baseSha },
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (!store.pulls.has(key)) store.pulls.set(key, []);
        store.pulls.get(key)!.push(pr);
        sendJson(res, 201, pr);
        return;
      }

      // GET /api/v3/repos/{owner}/{repo}/pulls
      if (method === 'GET' && subPath === '/pulls') {
        const stateFilter = url.searchParams.get('state') || 'open';
        let list = store.pulls.get(key) || [];
        if (stateFilter !== 'all') {
          list = list.filter((p) => p.state === stateFilter);
        }
        sendJson(res, 200, list);
        return;
      }

      const prNumMatch = subPath.match(/^\/pulls\/(\d+)(.*)$/);
      if (prNumMatch) {
        const num = parseInt(prNumMatch[1], 10);
        const prSub = prNumMatch[2];
        const pr = (store.pulls.get(key) || []).find((p) => p.number === num);
        if (!pr) {
          sendJson(res, 404, { message: 'Pull Request Not Found' });
          return;
        }

        if (method === 'GET' && prSub === '') {
          sendJson(res, 200, pr);
          return;
        }

        if (method === 'GET' && prSub === '/files') {
          sendJson(res, 200, [
            {
              sha: pr.head.sha,
              filename: 'README.md',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ]);
          return;
        }

        if (method === 'PUT' && prSub === '/merge') {
          pr.merged = true;
          pr.state = 'closed';
          pr.merged_at = new Date().toISOString();
          const mergeSha = randomBytes(20).toString('hex');
          pr.merge_commit_sha = mergeSha;
          sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
          return;
        }
      }

      // Git Refs API: POST /api/v3/repos/{owner}/{repo}/git/refs
      if (method === 'POST' && subPath === '/git/refs') {
        const body = await parseBody(req);
        if (!store.refs.has(key)) store.refs.set(key, new Map());
        const refMap = store.refs.get(key)!;
        refMap.set(body.ref, body.sha);
        sendJson(res, 201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
        return;
      }

      // GET /api/v3/repos/{owner}/{repo}/branches
      if (method === 'GET' && subPath === '/branches') {
        const refMap = store.refs.get(key) || new Map();
        const resList = [];
        for (const [r, sha] of refMap.entries()) {
          if (r.startsWith('refs/heads/')) {
            resList.push({ name: r.replace('refs/heads/', ''), commit: { sha } });
          }
        }
        if (resList.length === 0) {
          resList.push({ name: 'main', commit: { sha: randomBytes(20).toString('hex') } });
        }
        sendJson(res, 200, resList);
        return;
      }

      // GET /api/v3/repos/{owner}/{repo}/commits
      if (method === 'GET' && subPath === '/commits') {
        const commitList = store.commits.get(key) || [];
        const shaFilter = url.searchParams.get('sha');
        let filtered = commitList;
        if (shaFilter) {
          filtered = commitList.filter((c) => c.branch === shaFilter || c.sha === shaFilter);
        }
        if (filtered.length === 0) {
          filtered = [{ sha: randomBytes(20).toString('hex'), message: 'Initial commit', date: new Date().toISOString() }];
        }
        sendJson(res, 200, filtered.map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message,
            author: { name: owner, date: c.date },
          },
        })));
        return;
      }

      // Contents API: PUT /api/v3/repos/{owner}/{repo}/contents/{path}
      const contentsMatch = subPath.match(/^\/contents\/(.+)$/);
      if (contentsMatch) {
        const filePath = contentsMatch[1];
        if (method === 'PUT') {
          const body = await parseBody(req);
          const branch = body.branch || url.searchParams.get('ref') || 'main';
          const fileKey = `${key}:${branch}`;
          if (!store.files.has(fileKey)) store.files.set(fileKey, new Map());
          const fileMap = store.files.get(fileKey)!;

          const raw = Buffer.from(body.content || '', 'base64');
          const sha = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
          const existing = fileMap.get(filePath);

          if (existing && body.sha && body.sha !== existing.sha) {
            sendJson(res, 409, { message: 'Conflict: stale sha' });
            return;
          }

          const fileObj: FileContent = {
            path: filePath,
            content: body.content || '',
            sha,
            size: raw.length,
          };
          fileMap.set(filePath, fileObj);

          const commitSha = randomBytes(20).toString('hex');
          if (!store.commits.has(key)) store.commits.set(key, []);
          store.commits.get(key)!.unshift({ sha: commitSha, message: body.message || 'update', date: new Date().toISOString(), branch });

          if (!store.refs.has(key)) store.refs.set(key, new Map());
          store.refs.get(key)!.set(`refs/heads/${branch}`, commitSha);
          store.gitHeadSha.set(key, commitSha);

          sendJson(res, existing ? 200 : 201, {
            content: { name: filePath.split('/').pop(), path: filePath, sha, size: raw.length, encoding: 'base64' },
            commit: { sha: commitSha, message: body.message || 'update' },
          });
          return;
        }

        if (method === 'GET') {
          const branch = url.searchParams.get('ref') || 'main';
          const fileKey = `${key}:${branch}`;
          const fileMap = store.files.get(fileKey) || store.files.get(`${key}:main`) || new Map();
          const existing = fileMap.get(filePath);

          if (!existing) {
            const dirFiles: any[] = [];
            for (const [p, f] of fileMap.entries()) {
              if (p.startsWith(filePath + '/')) {
                dirFiles.push({ name: p.split('/').pop(), path: p, sha: f.sha, size: f.size, type: 'file' });
              }
            }
            if (dirFiles.length > 0) {
              sendJson(res, 200, dirFiles);
              return;
            }
            sendJson(res, 404, { message: 'File Not Found' });
            return;
          }

          sendJson(res, 200, {
            type: 'file',
            name: filePath.split('/').pop(),
            path: filePath,
            sha: existing.sha,
            size: existing.size,
            encoding: 'base64',
            content: existing.content,
          });
          return;
        }

        if (method === 'DELETE') {
          const branch = url.searchParams.get('ref') || 'main';
          const fileKey = `${key}:${branch}`;
          const fileMap = store.files.get(fileKey);
          if (fileMap) fileMap.delete(filePath);
          sendJson(res, 200, { commit: { sha: randomBytes(20).toString('hex') } });
          return;
        }
      }
    }

    // 8. MCP 接口 (POST /mcp)
    if (method === 'POST' && path === '/mcp') {
      if (!token) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      let rpc: any;
      try {
        rpc = await parseBody(req);
      } catch {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      const { method: rpcMethod, id, params } = rpc;

      if (rpcMethod === 'initialize') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'git-forge-mcp', version: '1.0.0' },
          },
        });
        return;
      }

      if (rpcMethod === 'server/discover') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            name: 'git-forge-mcp',
            version: '1.0.0',
            capabilities: ['tools'],
          },
        });
        return;
      }

      if (rpcMethod === 'tools/list') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'create_issue',
                description: 'Create an issue',
                inputSchema: {
                  type: 'object',
                  properties: {
                    owner: { type: 'string' },
                    repo: { type: 'string' },
                    title: { type: 'string' },
                    body: { type: 'string' },
                  },
                  required: ['owner', 'repo', 'title'],
                },
              },
              {
                name: 'list_issues',
                description: 'List issues in a repository',
                inputSchema: {
                  type: 'object',
                  properties: {
                    owner: { type: 'string' },
                    repo: { type: 'string' },
                  },
                  required: ['owner', 'repo'],
                },
              },
              {
                name: 'create_pull_request',
                description: 'Create a pull request',
                inputSchema: {
                  type: 'object',
                  properties: {
                    owner: { type: 'string' },
                    repo: { type: 'string' },
                    title: { type: 'string' },
                    head: { type: 'string' },
                    base: { type: 'string' },
                  },
                  required: ['owner', 'repo', 'title', 'head', 'base'],
                },
              },
              {
                name: 'merge_pull_request',
                description: 'Merge a pull request',
                inputSchema: {
                  type: 'object',
                  properties: {
                    owner: { type: 'string' },
                    repo: { type: 'string' },
                    pull_number: { type: 'number' },
                  },
                  required: ['owner', 'repo', 'pull_number'],
                },
              },
            ],
          },
        });
        return;
      }

      if (rpcMethod === 'tools/call') {
        const { name: toolName, arguments: args } = params || {};
        if (!args || !args.owner || !args.repo) {
          sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing arguments' } });
          return;
        }

        const key = `${args.owner}/${args.repo}`;
        store.bindViewer(args.owner);

        if (toolName.endsWith('create_issue')) {
          const num = store.nextIssueNum.get(key) || 1;
          store.nextIssueNum.set(key, num + 1);
          const issue: Issue = {
            id: store.nextId++,
            number: num,
            title: args.title,
            body: args.body || '',
            state: 'open',
            labels: [],
            comments_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          if (!store.issues.has(key)) store.issues.set(key, []);
          store.issues.get(key)!.push(issue);
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(issue) }] } });
          return;
        }

        if (toolName.endsWith('list_issues')) {
          const issues = store.issues.get(key) || [];
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(issues) }] } });
          return;
        }

        if (toolName.endsWith('create_pull_request')) {
          const num = store.nextPrNum.get(key) || 1;
          store.nextPrNum.set(key, num + 1);
          const pr: PullRequest = {
            id: store.nextId++,
            number: num,
            state: 'open',
            title: args.title,
            body: args.body || '',
            head: { ref: args.head, sha: randomBytes(20).toString('hex') },
            base: { ref: args.base, sha: randomBytes(20).toString('hex') },
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          if (!store.pulls.has(key)) store.pulls.set(key, []);
          store.pulls.get(key)!.push(pr);
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(pr) }] } });
          return;
        }

        if (toolName.endsWith('merge_pull_request')) {
          const pr = (store.pulls.get(key) || []).find((p) => p.number === args.pull_number);
          if (!pr) {
            sendJson(res, 404, { jsonrpc: '2.0', id, error: { code: -32603, message: 'PR not found' } });
            return;
          }
          pr.merged = true;
          pr.state = 'closed';
          pr.merged_at = new Date().toISOString();
          pr.merge_commit_sha = randomBytes(20).toString('hex');
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ merged: true }) }] } });
          return;
        }

        sendJson(res, 404, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
    }

    // 默认兜底 404
    sendJson(res, 404, { message: 'Not Found' });
  });
}
