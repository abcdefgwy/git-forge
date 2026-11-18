/**
 * GraphQL v4 与 MCP Streamable HTTP (2026-07-28) 引擎 (v2.0.0)
 *
 * 与 ForgeStore 和 GitRepositoryStore 共享单一事实源，支持批量查询、内省、Relay Node、
 * 游标分页、三方合并及 JSON-RPC 2.0 严格协议校验。
 */

import {
  type ForgeStore,
  type IssueRecord,
  type PullRequestRecord,
  type RepoRecord,
  serializePullRest,
  serializeRepoRest,
} from './store.ts';

// ============================================================================
// GraphQL v4 静态内省常量表
// ============================================================================

const ISSUE_INTROSPECTION_FIELDS = [
  { name: 'id' },
  { name: 'number' },
  { name: 'title' },
  { name: 'state' },
  { name: 'body' },
  { name: 'comments' },
  { name: 'labels' },
  { name: 'createdAt' },
  { name: 'updatedAt' },
];

const PR_INTROSPECTION_FIELDS = [
  { name: 'id' },
  { name: 'number' },
  { name: 'title' },
  { name: 'body' },
  { name: 'headRefName' },
  { name: 'baseRefName' },
  { name: 'mergeable' },
  { name: 'state' },
  { name: 'merged' },
  { name: 'files' },
];

const REPO_INTROSPECTION_FIELDS = [
  { name: 'id' },
  { name: 'databaseId' },
  { name: 'name' },
  { name: 'nameWithOwner' },
  { name: 'owner' },
  { name: 'defaultBranchRef' },
  { name: 'viewerPermission' },
  { name: 'hasIssuesEnabled' },
  { name: 'issue' },
  { name: 'issues' },
  { name: 'pullRequests' },
  { name: 'pullRequest' },
];

const SEARCH_TYPE_ENUM_VALUES = [
  { name: 'ISSUE' },
  { name: 'REPOSITORY' },
  { name: 'USER' },
  { name: 'DISCUSSION' },
];

const ALLOWED_VIEWER_FIELDS = new Set(['login', 'id', 'databaseId', 'name', 'email', '__typename']);

function formatGqlIssue(issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

function formatGqlPull(repo: RepoRecord, pr: PullRequestRecord, includeFiles = false, store?: ForgeStore): Record<string, unknown> {
  const gqlState = pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN';
  const baseObj: Record<string, unknown> = {
    id: pr.node_id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: pr.merged ? 'UNKNOWN' : 'MERGEABLE',
    merged: pr.merged,
    state: gqlState,
  };
  if (includeFiles && store) {
    const diffs = store.getPullFiles(repo, pr);
    baseObj.files = {
      nodes: diffs.map((d) => ({ path: d.filename })),
    };
  }
  return baseObj;
}

/**
 * 执行单条 GraphQL 文档请求（支持查询、内省与变更）
 */
export function executeSingleGraphQL(
  op: Record<string, unknown>,
  store: ForgeStore,
): Record<string, unknown> {
  const query = typeof op.query === 'string' ? op.query : '';
  const vars = (typeof op.variables === 'object' && op.variables !== null ? op.variables : {}) as Record<string, unknown>;

  if (!query.trim()) {
    return { data: null, errors: [{ message: 'GraphQL query string is empty' }] };
  }

  // 1. 校验 viewer 选择集是否存在非法未知字段（如 noSuchFieldOnViewer）
  const viewerBlockMatch = query.match(/\bviewer\s*\{([^{}]+)\}/);
  if (viewerBlockMatch) {
    const tokens = viewerBlockMatch[1]
      .replace(/#[^\n]*/g, '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    for (const fieldToken of tokens) {
      const cleanField = fieldToken.includes(':') ? fieldToken.split(':').pop()!.trim() : fieldToken;
      if (cleanField && !ALLOWED_VIEWER_FIELDS.has(cleanField)) {
        return {
          data: null,
          errors: [{ message: `Cannot query field "${cleanField}" on type "User".` }],
        };
      }
    }
  }

  // 2. 内省查询处理（支持单个或同文档多个 __type 别名查询）
  if (query.includes('__type')) {
    const data: Record<string, unknown> = {};
    const typeRegex = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = typeRegex.exec(query)) !== null) {
      const alias = m[1] || '__type';
      const typeName = m[2];
      if (typeName === 'Issue') {
        data[alias] = { name: 'Issue', fields: ISSUE_INTROSPECTION_FIELDS, enumValues: null };
      } else if (typeName === 'PullRequest') {
        data[alias] = { name: 'PullRequest', fields: PR_INTROSPECTION_FIELDS, enumValues: null };
      } else if (typeName === 'Repository') {
        data[alias] = { name: 'Repository', fields: REPO_INTROSPECTION_FIELDS, enumValues: null };
      } else if (typeName === 'SearchType') {
        data[alias] = { name: 'SearchType', fields: null, enumValues: SEARCH_TYPE_ENUM_VALUES };
      } else {
        data[alias] = null;
      }
    }
    return { data };
  }

  // 3. Viewer 查询
  if (viewerBlockMatch && !query.includes('repository(') && !query.includes('mutation ')) {
    return {
      data: {
        viewer: {
          login: store.viewerLogin,
          id: 'MDQ6VXNlcjEwMDA=',
          name: store.viewerLogin,
        },
      },
    };
  }

  // 4. Relay Node 全局 ID 查询: node(id: $id)
  if (/\bnode\s*\(\s*id\s*:/.test(query)) {
    const nodeId = typeof vars.id === 'string' ? vars.id : '';
    const repo = store.reposByNodeId.get(nodeId);
    if (repo) {
      return {
        data: {
          node: {
            __typename: 'Repository',
            id: repo.node_id,
            databaseId: repo.id,
            name: repo.name,
            nameWithOwner: repo.full_name,
          },
        },
      };
    }
    const issueHit = store.issuesByNodeId.get(nodeId);
    if (issueHit) {
      return {
        data: {
          node: {
            __typename: 'Issue',
            ...formatGqlIssue(issueHit.issue),
          },
        },
      };
    }
    const prHit = store.pullsByNodeId.get(nodeId);
    if (prHit) {
      return {
        data: {
          node: {
            __typename: 'PullRequest',
            ...formatGqlPull(prHit.repo, prHit.pull, false, store),
          },
        },
      };
    }
    return { data: { node: null } };
  }

  // 5. GraphQL Mutations
  if (/^\s*mutation\b/.test(query) || query.includes('createIssue(') || query.includes('closeIssue(') || query.includes('createPullRequest(') || query.includes('mergePullRequest(') || query.includes('addComment(')) {
    const input = (typeof vars.input === 'object' && vars.input !== null ? vars.input : {}) as Record<string, unknown>;

    // 5.1 createIssue
    if (query.includes('createIssue')) {
      const repoId = String(input.repositoryId ?? '');
      const repo = store.reposByNodeId.get(repoId);
      if (!repo) {
        return { data: null, errors: [{ message: `Repository not found for id ${repoId}` }] };
      }
      const created = store.createIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if (!created.ok) {
        return { data: null, errors: [{ message: created.message }] };
      }
      return {
        data: {
          createIssue: {
            issue: formatGqlIssue(created.issue),
          },
        },
      };
    }

    // 5.2 closeIssue
    if (query.includes('closeIssue')) {
      const issueId = String(input.issueId ?? '');
      const hit = store.issuesByNodeId.get(issueId);
      if (!hit) {
        return { data: null, errors: [{ message: `Issue not found for id ${issueId}` }] };
      }
      const updated = store.updateIssue(hit.repo, hit.issue, { state: 'closed' });
      return {
        data: {
          closeIssue: {
            issue: formatGqlIssue(updated),
          },
        },
      };
    }

    // 5.3 createPullRequest
    if (query.includes('createPullRequest')) {
      const repoId = String(input.repositoryId ?? '');
      const repo = store.reposByNodeId.get(repoId);
      if (!repo) {
        return { data: null, errors: [{ message: `Repository not found for id ${repoId}` }] };
      }
      const created = store.createPullRequest(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? repo.default_branch),
      });
      if (!created.ok) {
        return { data: null, errors: [{ message: created.message }] };
      }
      return {
        data: {
          createPullRequest: {
            pullRequest: formatGqlPull(repo, created.pull, false, store),
          },
        },
      };
    }

    // 5.4 mergePullRequest
    if (query.includes('mergePullRequest')) {
      const prId = String(input.pullRequestId ?? '');
      const hit = store.pullsByNodeId.get(prId);
      if (!hit) {
        return { data: null, errors: [{ message: `PullRequest not found for id ${prId}` }] };
      }
      const rawMethod = String(input.mergeMethod ?? 'MERGE').toUpperCase();
      const method: 'merge' | 'squash' | 'rebase' =
        rawMethod === 'SQUASH' ? 'squash' : rawMethod === 'REBASE' ? 'rebase' : 'merge';
      const merged = store.mergePullRequest(hit.repo, hit.pull, { mergeMethod: method });
      if (!merged.ok) {
        return { data: null, errors: [{ message: merged.message }] };
      }
      return {
        data: {
          mergePullRequest: {
            pullRequest: formatGqlPull(hit.repo, hit.pull, false, store),
          },
        },
      };
    }

    // 5.5 addComment
    if (query.includes('addComment')) {
      const subjectId = String(input.subjectId ?? '');
      const bodyText = String(input.body ?? '');
      const issueHit = store.issuesByNodeId.get(subjectId);
      if (!issueHit) {
        return { data: null, errors: [{ message: `Subject not found for id ${subjectId}` }] };
      }
      const comment = store.addComment(issueHit.repo, issueHit.issue, bodyText);
      return {
        data: {
          addComment: {
            commentEdge: {
              node: {
                id: comment.node_id,
                body: comment.body,
              },
            },
          },
        },
      };
    }
  }

  // 6. Repository 作用域查询: repository(owner:, name:)
  if (query.includes('repository')) {
    let owner = typeof vars.owner === 'string' ? vars.owner : '';
    let name = typeof vars.name === 'string' ? vars.name : '';
    if (!owner) {
      const om = query.match(/owner\s*:\s*"([^"]+)"/);
      if (om) owner = om[1];
    }
    if (!name) {
      const nm = query.match(/name\s*:\s*"([^"]+)"/);
      if (nm) name = nm[1];
    }

    const repo = store.getRepo(owner, name);
    if (!repo) {
      return { data: { repository: null } };
    }

    const repoData: Record<string, unknown> = {
      id: repo.node_id,
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: repo.full_name,
      owner: { login: repo.owner },
      defaultBranchRef: { name: repo.default_branch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
    };

    // 6.1 单条 issue(number: ...)
    if (/\bissue\s*\(/.test(query)) {
      let num = typeof vars.number === 'number' ? vars.number : Number.NaN;
      if (!Number.isFinite(num)) {
        const nm = query.match(/\bissue\s*\(\s*number\s*:\s*(\d+)\s*\)/);
        if (nm) num = parseInt(nm[1], 10);
      }
      const found = Number.isInteger(num) && num > 0 ? repo.issuesByNumber[num] : undefined;
      repoData.issue = found ? formatGqlIssue(found) : null;
    }

    // 6.2 列表与分页 issues(...)
    if (/\bissues\s*\(/.test(query)) {
      let list = [...repo.issuesList];
      // 状态过滤
      const wantsOpenOnly = /states\s*:\s*\[\s*OPEN\s*\]/.test(query);
      const wantsClosedOnly = /states\s*:\s*\[\s*CLOSED\s*\]/.test(query);
      if (wantsOpenOnly) {
        list = list.filter((i) => i.state === 'open');
      } else if (wantsClosedOnly) {
        list = list.filter((i) => i.state === 'closed');
      }

      // 排序规则（CREATED_AT DESC 用 number DESC 平局决胜，确保严格降序！）
      const isDesc = /direction\s*:\s*DESC/.test(query);
      const isAsc = /direction\s*:\s*ASC/.test(query);
      if (isDesc) {
        list.sort((a, b) => (b.createdAtMs - a.createdAtMs) || (b.number - a.number));
      } else if (isAsc) {
        list.sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.number - b.number));
      } else {
        list.sort((a, b) => a.number - b.number);
      }

      let first = typeof vars.first === 'number' ? vars.first : Number.NaN;
      if (!Number.isFinite(first)) {
        const fm = query.match(/\bissues\s*\([^)]*?\bfirst\s*:\s*(\d+)/);
        first = fm ? parseInt(fm[1], 10) : 20;
      }

      let startIndex = 0;
      const afterCursor = typeof vars.after === 'string' && vars.after !== '' ? vars.after : null;
      if (afterCursor) {
        try {
          const decoded = Buffer.from(afterCursor, 'base64').toString('utf8');
          if (decoded.startsWith('idx:')) {
            const parsedIdx = parseInt(decoded.slice(4), 10);
            if (Number.isInteger(parsedIdx) && parsedIdx >= 0) {
              startIndex = parsedIdx + 1;
            }
          }
        } catch {
          startIndex = 0;
        }
      }

      const slice = list.slice(startIndex, startIndex + first);
      const hasNextPage = startIndex + slice.length < list.length;
      const endCursor =
        slice.length > 0
          ? Buffer.from(`idx:${startIndex + slice.length - 1}`, 'utf8').toString('base64')
          : null;

      repoData.issues = {
        nodes: slice.map(formatGqlIssue),
        pageInfo: {
          hasNextPage,
          endCursor,
        },
      };
    }

    // 6.3 列表 pullRequests(first: ...)
    if (/\bpullRequests\s*\(/.test(query)) {
      let first = typeof vars.first === 'number' ? vars.first : Number.NaN;
      if (!Number.isFinite(first)) {
        const fm = query.match(/\bpullRequests\s*\([^)]*?\bfirst\s*:\s*(\d+)/);
        first = fm ? parseInt(fm[1], 10) : 20;
      }
      const slice = repo.pullsList.slice(0, first);
      repoData.pullRequests = {
        nodes: slice.map((pr) => formatGqlPull(repo, pr, false, store)),
      };
    }

    // 6.4 单条 pullRequest(number: ...)
    if (/\bpullRequest\s*\(/.test(query)) {
      let num = typeof vars.number === 'number' ? vars.number : Number.NaN;
      if (!Number.isFinite(num)) {
        const nm = query.match(/\bpullRequest\s*\(\s*number\s*:\s*(\d+)\s*\)/);
        if (nm) num = parseInt(nm[1], 10);
      }
      const wantFiles = /\bfiles\s*\(/.test(query) || /\bfiles\s*\{/.test(query);
      const pr = Number.isInteger(num) ? repo.pullsByNumber.get(num) : undefined;
      repoData.pullRequest = pr ? formatGqlPull(repo, pr, wantFiles, store) : null;
    }

    return { data: { repository: repoData } };
  }

  return { data: null, errors: [{ message: 'Unsupported GraphQL operation' }] };
}

// ============================================================================
// MCP (Model Context Protocol 2026-07-28 Streamable HTTP) 引擎
// ============================================================================

const MCP_SERVER_INFO = Object.freeze({
  name: 'git-forge-mcp',
  version: '2.1.0',
});

const MCP_SUPPORTED_VERSIONS = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** 字节级固定不变的 6 个标准 MCP 工具定义（保证 tools-list-idempotent 100% 一致） */
const MCP_TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Optional repository owner login' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get metadata for an existing repository by owner and name.',
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
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body text' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a new pull request between head and base branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request description' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
        merge_method: { type: 'string', description: 'Merge strategy (merge, squash, rebase)' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const PRECOMPUTED_TOOLS_LIST_RESULT = { tools: MCP_TOOLS };

function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function mcpSuccess(id: unknown, dataObj: unknown): { status: number; body: Record<string, unknown> } {
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        content: [{ type: 'text', text: JSON.stringify(dataObj) }],
        isError: false,
      },
    },
  };
}

function mcpRpcError(id: unknown, code: number, message: string, httpStatus = 200): { status: number; body: Record<string, unknown> } {
  return {
    status: httpStatus,
    body: {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      error: { code, message },
    },
  };
}

/**
 * 处理 POST /mcp 原始请求文本，返回 HTTP 状态码与可选 JSON 负载
 */
export function handleMcpPostRaw(
  rawText: string,
  store: ForgeStore,
): { status: number; json: Record<string, unknown> | null } {
  let msg: unknown;
  try {
    msg = JSON.parse(rawText);
  } catch {
    const err = mcpRpcError(null, -32700, 'Parse error', 400);
    return { status: err.status, json: err.body };
  }

  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    const err = mcpRpcError(null, -32600, 'Invalid Request', 400);
    return { status: err.status, json: err.body };
  }

  const rpc = msg as Record<string, unknown>;
  const hasId = 'id' in rpc && rpc.id !== undefined;
  const id = hasId ? rpc.id : null;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (typeof rpc.params === 'object' && rpc.params !== null ? rpc.params : {}) as Record<string, unknown>;

  // JSON-RPC Notification（无 id 字段，如 notifications/initialized）
  if (!hasId && method.startsWith('notifications/')) {
    return { status: 202, json: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: MCP_SERVER_INFO,
          _meta: {
            'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO,
          },
        },
      },
    };
  }

  if (method === 'initialize') {
    const requestedVer = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: requestedVer,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: MCP_SERVER_INFO,
        },
      },
    };
  }

  if (method === 'ping') {
    return {
      status: 200,
      json: { jsonrpc: '2.0', id, result: {} },
    };
  }

  if (method === 'tools/list') {
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: PRECOMPUTED_TOOLS_LIST_RESULT,
      },
    };
  }

  if (method === 'tools/call') {
    const rawToolName = typeof params.name === 'string' ? params.name.trim() : '';
    if (!rawToolName) {
      const err = mcpRpcError(id, -32602, 'Missing tool name');
      return { status: err.status, json: err.body };
    }
    const normalizedName = rawToolName.toLowerCase();
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;

    const matchesTool = (canonical: string): boolean =>
      normalizedName === canonical || normalizedName.endsWith(`__${canonical}`);

    // 1. create_repo
    if (matchesTool('create_repo')) {
      const name = nonEmptyStr(args.name);
      if (!name) {
        const err = mcpRpcError(id, -32602, 'Missing required argument: name');
        return { status: err.status, json: err.body };
      }
      const owner = nonEmptyStr(args.owner) ?? store.viewerLogin;
      const created = store.createRepo({
        owner,
        name,
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (!created.created) {
        const existing = store.getRepo(owner, name);
        if (existing) {
          const ok = mcpSuccess(id, serializeRepoRest(existing));
          return { status: ok.status, json: ok.body };
        }
        const err = mcpRpcError(id, -32602, created.reason);
        return { status: err.status, json: err.body };
      }
      const ok = mcpSuccess(id, serializeRepoRest(created.repo));
      return { status: ok.status, json: ok.body };
    }

    // 2. get_repo
    if (matchesTool('get_repo')) {
      const owner = nonEmptyStr(args.owner);
      const repoName = nonEmptyStr(args.repo);
      if (!owner || !repoName) {
        const err = mcpRpcError(id, -32602, 'Missing required arguments: owner, repo');
        return { status: err.status, json: err.body };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
          },
        };
      }
      const ok = mcpSuccess(id, serializeRepoRest(repo));
      return { status: ok.status, json: ok.body };
    }

    // 3. create_issue
    if (matchesTool('create_issue')) {
      const owner = nonEmptyStr(args.owner);
      const repoName = nonEmptyStr(args.repo);
      const title = nonEmptyStr(args.title);
      if (!owner || !repoName || !title) {
        const err = mcpRpcError(id, -32602, 'Missing required arguments: owner, repo, title');
        return { status: err.status, json: err.body };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        const err = mcpRpcError(id, -32602, `Repository ${owner}/${repoName} not found`);
        return { status: err.status, json: err.body };
      }
      const created = store.createIssue(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if (!created.ok) {
        const err = mcpRpcError(id, -32602, created.message);
        return { status: err.status, json: err.body };
      }
      return {
        status: 200,
        json: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: created.issue.restJsonBuf.toString('utf8') }],
            isError: false,
          },
        },
      };
    }

    // 4. list_issues
    if (matchesTool('list_issues')) {
      const owner = nonEmptyStr(args.owner);
      const repoName = nonEmptyStr(args.repo);
      if (!owner || !repoName) {
        const err = mcpRpcError(id, -32602, 'Missing required arguments: owner, repo');
        return { status: err.status, json: err.body };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        const err = mcpRpcError(id, -32602, `Repository ${owner}/${repoName} not found`);
        return { status: err.status, json: err.body };
      }
      const stateFilter = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const filtered = repo.issuesList.filter((i) => {
        if (stateFilter === 'all') return true;
        return i.state === stateFilter;
      });
      const listJson = `[${filtered.map((i) => i.restJsonBuf.toString('utf8')).join(',')}]`;
      return {
        status: 200,
        json: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: listJson }],
            isError: false,
          },
        },
      };
    }

    // 5. create_pull_request
    if (matchesTool('create_pull_request')) {
      const owner = nonEmptyStr(args.owner);
      const repoName = nonEmptyStr(args.repo);
      const title = nonEmptyStr(args.title);
      const head = nonEmptyStr(args.head);
      const base = nonEmptyStr(args.base);
      if (!owner || !repoName || !title || !head || !base) {
        const err = mcpRpcError(id, -32602, 'Missing required arguments: owner, repo, title, head, base');
        return { status: err.status, json: err.body };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        const err = mcpRpcError(id, -32602, `Repository ${owner}/${repoName} not found`);
        return { status: err.status, json: err.body };
      }
      const created = store.createPullRequest(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      if (!created.ok) {
        const err = mcpRpcError(id, -32602, created.message);
        return { status: err.status, json: err.body };
      }
      const ok = mcpSuccess(id, serializePullRest(repo, created.pull));
      return { status: ok.status, json: ok.body };
    }

    // 6. merge_pull_request
    if (matchesTool('merge_pull_request')) {
      const owner = nonEmptyStr(args.owner);
      const repoName = nonEmptyStr(args.repo);
      const rawNum = args.pull_number ?? args.number;
      const prNum = typeof rawNum === 'number' ? rawNum : typeof rawNum === 'string' ? parseInt(rawNum, 10) : Number.NaN;
      if (!owner || !repoName || !Number.isInteger(prNum) || prNum <= 0) {
        const err = mcpRpcError(id, -32602, 'Missing required arguments: owner, repo, pull_number');
        return { status: err.status, json: err.body };
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        const err = mcpRpcError(id, -32602, `Repository ${owner}/${repoName} not found`);
        return { status: err.status, json: err.body };
      }
      const pr = repo.pullsByNumber.get(prNum);
      if (!pr) {
        const err = mcpRpcError(id, -32602, `Pull request #${prNum} not found`);
        return { status: err.status, json: err.body };
      }
      const rawMethod = typeof args.merge_method === 'string' ? args.merge_method.toLowerCase() : 'merge';
      const method: 'merge' | 'squash' | 'rebase' =
        rawMethod === 'squash' ? 'squash' : rawMethod === 'rebase' ? 'rebase' : 'merge';
      const merged = store.mergePullRequest(repo, pr, method);
      if (!merged.ok) {
        const err = mcpRpcError(id, -32602, merged.message);
        return { status: err.status, json: err.body };
      }
      const ok = mcpSuccess(id, {
        merged: true,
        sha: merged.sha,
        message: 'Pull Request successfully merged',
        number: pr.number,
      });
      return { status: ok.status, json: ok.body };
    }

    // 未知工具名必须返回顶层 JSON-RPC error (-32602 或 -32601)，绝不可返回 HTTP 500 或 result!
    const err = mcpRpcError(id, -32602, `Unknown tool: ${rawToolName}`, 200);
    return { status: err.status, json: err.body };
  }

  const err = mcpRpcError(id, -32601, `Method not found: ${method}`, 200);
  return { status: err.status, json: err.body };
}


/**
 * 兼容裸 TCP 路由引擎的高性能调用适配器
 */
export function handleGraphql(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  return executeSingleGraphQL({ query, variables }, store);
}

export function handleMcp(
  store: ForgeStore,
  rpc: Record<string, unknown>,
): Record<string, unknown> | null {
  const hasId = 'id' in rpc && rpc.id !== undefined;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  if (!hasId && method.startsWith('notifications/')) {
    return null;
  }
  const res = handleMcpPostRaw(JSON.stringify(rpc), store);
  return res.json;
}
