/**
 * Git Forge 高性能 HTTP 核心路由层 (v2.0.0)
 *
 * 启用 TCP_NODELAY、显式 Content-Length、热点路由零 URL 解析直通车，
 * 完整支持 Git Smart HTTP v0/v2、REST API v3、GraphQL v4 与 MCP 2026-07-28。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  V2_UPLOAD_ADVERTISEMENT_BUF,
  decodeRequestPktStream,
  isHex40,
} from './git-engine.ts';
import { executeSingleGraphQL, handleMcpPostRaw } from './graphql-mcp.ts';
import {
  DEFAULT_VIEWER_EMAIL,
  DEFAULT_VIEWER_NAME,
  ForgeStore,
  serializePullRest,
  serializeRepoRest,
} from './store.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const HEALTHZ_OK_BUF = Buffer.from('{"ok":true}', 'utf8');
const ERR_401_BUF = Buffer.from('{"message":"Requires authentication"}', 'utf8');
const ERR_404_BUF = Buffer.from('{"message":"Not Found"}', 'utf8');
const ERR_400_JSON_BUF = Buffer.from('{"message":"Problems parsing JSON"}', 'utf8');

const API_V3_ROOT_BUF = Buffer.from(
  JSON.stringify({
    current_user_url: '/api/v3/user',
    current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
    emails_url: '/api/v3/user/emails',
    issues_url: '/api/v3/issues',
    organization_url: '/api/v3/orgs/{org}',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    user_url: '/api/v3/users/{user}',
  }),
  'utf8',
);

const API_V3_META_BUF = Buffer.from(
  JSON.stringify({
    verifiable_password_authentication: false,
    installed_version: '3.14.0',
  }),
  'utf8',
);

let lastRequestActivityMs = 0;

export function getLastRequestActivityMs(): number {
  return lastRequestActivityMs;
}

const STATIC_REQ_ID = 'r1';

function sendJsonBuf(
  res: ServerResponse,
  status: number,
  buf: Buffer,
  extraHeaders?: Record<string, string>,
): void {
  const sock = res.socket;
  if (sock?.cork) sock.cork();
  if (!extraHeaders) {
    res.writeHead(status, [
      'Content-Type',
      JSON_CONTENT_TYPE,
      'Content-Length',
      String(buf.length),
      'X-GitHub-Request-Id',
      STATIC_REQ_ID,
    ]);
    res.end(buf);
    if (sock?.uncork) sock.uncork();
    return;
  }
  const headers: Record<string, string | number> = {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': buf.length,
    'x-github-request-id': STATIC_REQ_ID,
  };
  for (const k of Object.keys(extraHeaders)) {
    headers[k] = extraHeaders[k];
  }
  res.writeHead(status, headers);
  res.end(buf);
  if (sock?.uncork) sock.uncork();
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (status === 204 || payload === null && status === 202) {
    const sock = res.socket;
    if (sock?.cork) sock.cork();
    const headers: Record<string, string | number> = {
      'content-length': 0,
      'x-github-request-id': STATIC_REQ_ID,
    };
    if (extraHeaders) {
      for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
    }
    res.writeHead(status, headers);
    res.end();
    if (sock?.uncork) sock.uncork();
    return;
  }
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  sendJsonBuf(res, status, buf, extraHeaders);
}

function sendBinary(res: ServerResponse, status: number, contentType: string, buf: Buffer): void {
  const sock = res.socket;
  if (sock?.cork) sock.cork();
  res.writeHead(status, [
    'Content-Type',
    contentType,
    'Content-Length',
    String(buf.length),
    'Cache-Control',
    'no-cache',
    'X-GitHub-Request-Id',
    STATIC_REQ_ID,
  ]);
  res.end(buf);
  if (sock?.uncork) sock.uncork();
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let firstChunk: Buffer | null = null;
    let chunks: Buffer[] | null = null;
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (firstChunk === null) {
        firstChunk = b;
      } else {
        if (chunks === null) chunks = [firstChunk];
        chunks.push(b);
      }
    });
    req.on('end', () => {
      if (firstChunk === null) resolve(Buffer.alloc(0));
      else if (chunks === null) resolve(firstChunk);
      else resolve(Buffer.concat(chunks, total));
    });
    req.on('error', reject);
  });
}

async function readJsonObject(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function safeDecodeSegment(seg: string): string {
  if (!seg.includes('%')) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function buildPaginationLinkHeader(
  req: IncomingMessage,
  pathname: string,
  params: URLSearchParams,
  page: number,
  perPage: number,
  totalItems: number,
): Record<string, string> | undefined {
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const host = req.headers.host || '127.0.0.1';
  const base = `http://${host}${pathname}`;
  const links: string[] = [];

  const makeUrl = (targetPage: number): string => {
    const copy = new URLSearchParams(params);
    copy.set('per_page', String(perPage));
    copy.set('page', String(targetPage));
    return `${base}?${copy.toString()}`;
  };

  if (page < totalPages) {
    links.push(`<${makeUrl(page + 1)}>; rel="next"`);
    links.push(`<${makeUrl(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${makeUrl(page - 1)}>; rel="prev"`);
    links.push(`<${makeUrl(1)}>; rel="first"`);
  }
  return links.length > 0 ? { Link: links.join(', ') } : undefined;
}

export function createApp(): Server {
  const store = new ForgeStore();
  const configuredToken = (process.env.MAKEFUN_SHOP_TOKEN || '').trim();
  const expectedBearer = configuredToken ? `Bearer ${configuredToken}` : '';

  const checkAuth = (authHeader: string | undefined): boolean => {
    if (!authHeader) return false;
    if (configuredToken) {
      if (authHeader === expectedBearer) return true;
      const m = authHeader.match(/^(?:Bearer|token)\s+(.+)$/i);
      return m !== null && m[1].trim() === configuredToken;
    }
    return /^(?:Bearer|token)\s+\S+/i.test(authHeader);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    lastRequestActivityMs = performance.now();
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
    const rawQuery = qIndex < 0 ? '' : rawUrl.slice(qIndex + 1);

    // ========================================================================
    // 1. 健康探针（无鉴权要求，最快路径）
    // ========================================================================
    if (pathname === '/healthz' && method === 'GET') {
      sendJsonBuf(res, 200, HEALTHZ_OK_BUF);
      return;
    }

    const authHeader = req.headers.authorization;

    // ========================================================================
    // 2. REST v3 热点直通车: GET / POST /api/v3/repos/:owner/:repo/issues[/:num]
    //    针对 bench.read (6,005 次) 与 bench.write (605 次) 实现零冗余分配
    // ========================================================================
    if (pathname.startsWith('/api/v3/repos/')) {
      if (!checkAuth(authHeader)) {
        sendJsonBuf(res, 401, ERR_401_BUF);
        return;
      }

      const afterRepos = pathname.slice(14); // 去除 '/api/v3/repos/'
      const slash1 = afterRepos.indexOf('/');
      if (slash1 > 0) {
        const owner = safeDecodeSegment(afterRepos.slice(0, slash1));
        const restAfterOwner = afterRepos.slice(slash1 + 1);
        const slash2 = restAfterOwner.indexOf('/');
        const repoName = safeDecodeSegment(slash2 < 0 ? restAfterOwner : restAfterOwner.slice(0, slash2));
        const subPath = slash2 < 0 ? '' : restAfterOwner.slice(slash2);

        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendJsonBuf(res, 404, ERR_404_BUF);
          return;
        }

        // 极速直通车 A: GET /api/v3/repos/:owner/:repo/issues/:number
        if (method === 'GET' && qIndex < 0 && subPath.startsWith('/issues/')) {
          const tail = subPath.slice(8);
          if (tail.length > 0 && !tail.includes('/')) {
            const num = Number(tail);
            if (Number.isInteger(num) && num > 0) {
              const issue = repo.issuesByNumber[num];
              if (issue) {
                const sock = res.socket;
                if (sock?.cork) sock.cork();
                res.writeHead(200, issue.restHeaders);
                res.end(issue.restJsonBuf);
                if (sock?.uncork) sock.uncork();
              } else {
                sendJsonBuf(res, 404, ERR_404_BUF);
              }
              return;
            }
          }
        }

        // 极速直通车 B: POST /api/v3/repos/:owner/:repo/issues
        if (method === 'POST' && subPath === '/issues') {
          const parsed = await readJsonObject(req);
          if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
            sendJsonBuf(res, 400, ERR_400_JSON_BUF);
            return;
          }
          const body = parsed.value as Record<string, unknown>;
          if (typeof body.title !== 'string' || body.title.trim() === '') {
            sendJson(res, 422, { message: 'Validation Failed: title is required' });
            return;
          }
          const created = store.createIssue(repo, {
            title: body.title,
            body: typeof body.body === 'string' ? body.body : '',
            labelNames: Array.isArray(body.labels) ? body.labels : undefined,
          });
          if (!created.ok) {
            sendJson(res, created.status, { message: created.message });
            return;
          }
          const sock = res.socket;
          if (sock?.cork) sock.cork();
          res.writeHead(201, created.issue.restHeaders);
          res.end(created.issue.restJsonBuf);
          if (sock?.uncork) sock.uncork();
          return;
        }

        // 其余 /api/v3/repos/:owner/:repo 子路由处理
        await handleRepoSubroutes(req, res, method, pathname, rawQuery, store, repo, subPath);
        return;
      }
    }

    // ========================================================================
    // 3. Git Smart HTTP 路由（零正则、零 URLSearchParams 快速匹配）
    // ========================================================================
    if (!pathname.startsWith('/api/') && pathname !== '/mcp') {
      let gitAction: 'info/refs' | 'git-upload-pack' | 'git-receive-pack' | null = null;
      let prefixEnd = -1;
      if (pathname.endsWith('/info/refs')) {
        gitAction = 'info/refs';
        prefixEnd = pathname.length - 10;
      } else if (pathname.endsWith('/git-upload-pack')) {
        gitAction = 'git-upload-pack';
        prefixEnd = pathname.length - 16;
      } else if (pathname.endsWith('/git-receive-pack')) {
        gitAction = 'git-receive-pack';
        prefixEnd = pathname.length - 17;
      }

      if (gitAction !== null && prefixEnd > 2) {
        const ownerRepoSlice = pathname.slice(1, prefixEnd);
        const sepIdx = ownerRepoSlice.indexOf('/');
        if (sepIdx > 0 && ownerRepoSlice.indexOf('/', sepIdx + 1) < 0) {
          if (authHeader && !checkAuth(authHeader)) {
            sendJsonBuf(res, 401, ERR_401_BUF);
            return;
          }
          const owner = safeDecodeSegment(ownerRepoSlice.slice(0, sepIdx));
          const rawRepoPart = ownerRepoSlice.slice(sepIdx + 1);
          const repoName = safeDecodeSegment(
            rawRepoPart.endsWith('.git') ? rawRepoPart.slice(0, -4) : rawRepoPart,
          );

          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJsonBuf(res, 404, ERR_404_BUF);
            return;
          }

          const gitProtoHeader = req.headers['git-protocol'];
          const wantsV2 = typeof gitProtoHeader === 'string' && gitProtoHeader.includes('version=2');

          if (gitAction === 'info/refs' && method === 'GET') {
            let service: string | null = null;
            if (rawQuery === 'service=git-upload-pack') service = 'git-upload-pack';
            else if (rawQuery === 'service=git-receive-pack') service = 'git-receive-pack';
            else service = new URLSearchParams(rawQuery).get('service');

            if (service === 'git-upload-pack') {
              const payload = wantsV2 ? V2_UPLOAD_ADVERTISEMENT_BUF : repo.git.buildUploadPackAdvV0();
              sendBinary(res, 200, 'application/x-git-upload-pack-advertisement', payload);
              return;
            }
            if (service === 'git-receive-pack') {
              const payload = repo.git.buildReceivePackAdv();
              sendBinary(res, 200, 'application/x-git-receive-pack-advertisement', payload);
              return;
            }
            sendJson(res, 400, { message: 'Unsupported git service' });
            return;
          }

          if (gitAction === 'git-upload-pack' && method === 'POST') {
            const rawBody = await readRawBody(req);
            try {
              if (wantsV2) {
                const rawKey = rawBody.length <= 512 ? rawBody.toString('latin1') : null;
                if (rawKey !== null) {
                  const fastCached = repo.git.cachedV2RawBody.get(rawKey);
                  if (fastCached) {
                    sendBinary(res, 200, 'application/x-git-upload-pack-result', fastCached);
                    return;
                  }
                }

                const { sections } = decodeRequestPktStream(rawBody);
                const cmdSec = sections[0] ?? [];
                const cmdLine = cmdSec.find((l) => l.startsWith('command='))?.replace(/\r?\n$/, '') ?? '';
                const argLines = sections.slice(1).flat();

                if (cmdLine === 'command=ls-refs') {
                  const out = repo.git.handleV2LsRefs(argLines, rawKey ?? rawBody.toString('latin1'));
                  if (rawKey !== null && repo.git.cachedV2RawBody.size < 32) {
                    repo.git.cachedV2RawBody.set(rawKey, out);
                  }
                  sendBinary(res, 200, 'application/x-git-upload-pack-result', out);
                  return;
                }
                if (cmdLine === 'command=fetch') {
                  const out = repo.git.handleV2Fetch(argLines, rawKey);
                  if (rawKey !== null && repo.git.cachedV2RawBody.size < 32) {
                    repo.git.cachedV2RawBody.set(rawKey, out);
                  }
                  sendBinary(res, 200, 'application/x-git-upload-pack-result', out);
                  return;
                }
                sendJson(res, 400, { message: `Unsupported v2 command: ${cmdLine}` });
                return;
              } else {
                const { sections } = decodeRequestPktStream(rawBody);
                const out = repo.git.handleV0Fetch(sections);
                sendBinary(res, 200, 'application/x-git-upload-pack-result', out);
                return;
              }
            } catch (err) {
              sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad pkt-line request' });
              return;
            }
          }

          if (gitAction === 'git-receive-pack' && method === 'POST') {
            const rawBody = await readRawBody(req);
            try {
              const wasEmpty = repo.git.refs.size === 0;
              const out = repo.git.handleReceivePack(rawBody);
              if (wasEmpty && repo.git.refs.size > 0 && !repo.git.refs.has(`refs/heads/${repo.default_branch}`)) {
                for (const refKey of repo.git.refs.keys()) {
                  if (refKey.startsWith('refs/heads/')) {
                    const firstBranch = refKey.slice('refs/heads/'.length);
                    repo.default_branch = firstBranch;
                    repo.git.defaultBranch = firstBranch;
                    repo.git.bumpVersion();
                    break;
                  }
                }
              }
              sendBinary(res, 200, 'application/x-git-receive-pack-result', out);
              return;
            } catch (err) {
              sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad receive-pack request' });
              return;
            }
          }
        }
      }
    }

    // ========================================================================
    // 4. MCP Streamable HTTP 端点: /mcp
    // ========================================================================
    if (pathname === '/mcp') {
      if (!checkAuth(authHeader)) {
        sendJsonBuf(res, 401, ERR_401_BUF);
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 204, null);
        return;
      }
      if (method === 'POST') {
        const rawBuf = await readRawBody(req);
        const mcpOut = handleMcpPostRaw(rawBuf.toString('utf8'), store);
        if (mcpOut.json === null) {
          sendJson(res, mcpOut.status, null);
        } else {
          sendJson(res, mcpOut.status, mcpOut.json);
        }
        return;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }

    // ========================================================================
    // 5. GraphQL v4 端点: POST /api/graphql
    // ========================================================================
    if ((pathname === '/api/graphql' || pathname === '/graphql') && method === 'POST') {
      if (!checkAuth(authHeader)) {
        sendJsonBuf(res, 401, ERR_401_BUF);
        return;
      }
      const parsed = await readJsonObject(req);
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      if (Array.isArray(parsed.value)) {
        const batchResults = parsed.value.map((entry) =>
          typeof entry === 'object' && entry !== null
            ? executeSingleGraphQL(entry as Record<string, unknown>, store)
            : { data: null, errors: [{ message: 'Invalid operation entry' }] },
        );
        sendJson(res, 200, batchResults);
        return;
      }
      const singleResult = executeSingleGraphQL(parsed.value as Record<string, unknown>, store);
      sendJson(res, 200, singleResult);
      return;
    }

    // ========================================================================
    // 6. 顶层 REST v3 端点 (/api/v3/*)
    // ========================================================================
    if (pathname === '/api/v3' || pathname === '/api/v3/' || pathname.startsWith('/api/v3/')) {
      if (!checkAuth(authHeader)) {
        sendJsonBuf(res, 401, ERR_401_BUF);
        return;
      }

      if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
        sendJsonBuf(res, 200, API_V3_ROOT_BUF, { 'x-oauth-scopes': 'repo, read:org, user' });
        return;
      }

      if (method === 'GET' && pathname === '/api/v3/meta') {
        sendJsonBuf(res, 200, API_V3_META_BUF);
        return;
      }

      if (method === 'GET' && pathname === '/api/v3/rate_limit') {
        sendJson(res, 200, {
          resources: { core: { limit: 5000, remaining: 4999, reset: 1900000000 } },
          rate: { limit: 5000, remaining: 4999, reset: 1900000000 },
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/v3/user') {
        sendJson(res, 200, {
          login: store.viewerLogin,
          id: 1000,
          node_id: 'MDQ6VXNlcjEwMDA=',
          name: DEFAULT_VIEWER_NAME,
          email: DEFAULT_VIEWER_EMAIL,
          type: 'User',
          site_admin: false,
        });
        return;
      }

      if (pathname === '/api/v3/user/repos') {
        if (method === 'POST') {
          const parsed = await readJsonObject(req);
          if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
            sendJsonBuf(res, 400, ERR_400_JSON_BUF);
            return;
          }
          const body = parsed.value as Record<string, unknown>;
          const repoName = typeof body.name === 'string' ? body.name.trim() : '';
          if (!repoName) {
            sendJson(res, 422, { message: 'Validation Failed: name is required' });
            return;
          }
          const created = store.createRepo({
            owner: store.viewerLogin,
            name: repoName,
            isPrivate: typeof body.private === 'boolean' ? body.private : false,
            description: typeof body.description === 'string' ? body.description : '',
            defaultBranch: typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : 'main',
          });
          if (!created.created) {
            sendJson(res, 422, {
              message: `Repository creation failed: name ${repoName} already exists on this account`,
            });
            return;
          }
          sendJson(res, 201, serializeRepoRest(created.repo));
          return;
        }

        if (method === 'GET') {
          const params = new URLSearchParams(rawQuery);
          const perPage = Math.min(100, Math.max(1, parseInt(params.get('per_page') ?? '30', 10) || 30));
          const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);

          const owned = [...store.repos.values()].filter((r) => r.owner === store.viewerLogin);
          const start = (page - 1) * perPage;
          const slice = owned.slice(start, start + perPage).map(serializeRepoRest);
          const linkHdr = buildPaginationLinkHeader(req, pathname, params, page, perPage, owned.length);
          sendJson(res, 200, slice, linkHdr);
          return;
        }
      }

      sendJsonBuf(res, 404, ERR_404_BUF);
      return;
    }

    // 7. 全局 JSON 404 兜底（严禁任何 HTML 输出）
    sendJsonBuf(res, 404, ERR_404_BUF);
  };

  const server = createServer({ noDelay: true, keepAlive: true }, (req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });

  server.sendDate = false;
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.maxRequestsPerSocket = 0;

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  return server;
}

/**
 * 处理 /api/v3/repos/:owner/:repo 下的所有 REST v3 子路由
 */
async function handleRepoSubroutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  rawQuery: string,
  store: ForgeStore,
  repo: ReturnType<ForgeStore['getRepo']> & object,
  subPath: string,
): Promise<void> {
  // 1. 仓库自身: GET / PATCH / DELETE /api/v3/repos/:owner/:repo
  if (subPath === '' || subPath === '/') {
    if (method === 'GET') {
      sendJson(res, 200, serializeRepoRest(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      const body = parsed.value as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      else if (body.description === null) repo.description = '';
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch.trim() !== '') {
        repo.default_branch = body.default_branch.trim();
        repo.git.defaultBranch = repo.default_branch;
        repo.git.bumpVersion();
      }
      sendJson(res, 200, serializeRepoRest(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendJson(res, 204, null);
      return;
    }
  }

  // 2. 分支 API: GET /branches 与 GET /branches/*branchName（支持含 / 的分支名）
  if (subPath === '/branches' && method === 'GET') {
    const branches: Array<{ name: string; commit: { sha: string }; protected: boolean }> = [];
    for (const [refName, oid] of repo.git.refs.entries()) {
      if (refName.startsWith('refs/heads/')) {
        branches.push({
          name: refName.slice('refs/heads/'.length),
          commit: { sha: oid },
          protected: false,
        });
      }
    }
    sendJson(res, 200, branches);
    return;
  }

  if (subPath.startsWith('/branches/') && method === 'GET') {
    const branchName = subPath.slice('/branches/'.length).split('/').map(safeDecodeSegment).join('/');
    const oid = repo.git.refs.get(`refs/heads/${branchName}`);
    if (!oid) {
      sendJsonBuf(res, 404, ERR_404_BUF);
      return;
    }
    sendJson(res, 200, {
      name: branchName,
      commit: { sha: oid },
      protected: false,
    });
    return;
  }

  // 3. Git Refs API: POST /git/refs 与 GET/PATCH/DELETE /git/ref(s)/*
  if (subPath === '/git/refs' && method === 'POST') {
    const parsed = await readJsonObject(req);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      sendJsonBuf(res, 400, ERR_400_JSON_BUF);
      return;
    }
    const body = parsed.value as Record<string, unknown>;
    const rawRef = typeof body.ref === 'string' ? body.ref.trim() : '';
    const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
    const fullRef = rawRef.startsWith('refs/') ? rawRef : `refs/heads/${rawRef}`;

    if (!rawRef || !isHex40(sha)) {
      sendJson(res, 422, { message: 'Validation Failed: valid ref and 40-char sha required' });
      return;
    }
    if (repo.git.refs.has(fullRef)) {
      sendJson(res, 422, { message: `Reference ${fullRef} already exists` });
      return;
    }
    if (!repo.git.objects.has(sha)) {
      sendJson(res, 422, { message: `Object ${sha} does not exist` });
      return;
    }
    repo.git.refs.set(fullRef, sha);
    repo.git.bumpVersion();
    sendJson(res, 201, {
      ref: fullRef,
      node_id: `REF_${fullRef}`,
      object: { sha, type: repo.git.objects.get(sha)!.type },
    });
    return;
  }

  if (subPath.startsWith('/git/refs/') || subPath.startsWith('/git/ref/')) {
    const rawTail = subPath.startsWith('/git/refs/')
      ? subPath.slice('/git/refs/'.length)
      : subPath.slice('/git/ref/'.length);
    const decodedTail = rawTail.split('/').map(safeDecodeSegment).join('/');
    const fullRef = decodedTail.startsWith('refs/') ? decodedTail : `refs/${decodedTail}`;

    if (method === 'GET') {
      const sha = repo.git.refs.get(fullRef);
      if (!sha) {
        sendJsonBuf(res, 404, ERR_404_BUF);
        return;
      }
      sendJson(res, 200, {
        ref: fullRef,
        object: { sha, type: repo.git.objects.get(sha)?.type ?? 'commit' },
      });
      return;
    }

    if (method === 'PATCH') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      const body = parsed.value as Record<string, unknown>;
      const newSha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
      const force = Boolean(body.force);
      const curSha = repo.git.refs.get(fullRef);
      if (!curSha) {
        sendJsonBuf(res, 404, ERR_404_BUF);
        return;
      }
      if (!isHex40(newSha) || !repo.git.objects.has(newSha)) {
        sendJson(res, 422, { message: 'Invalid target SHA' });
        return;
      }
      if (!force && !repo.git.isAncestor(curSha, newSha)) {
        sendJson(res, 422, { message: 'Update is not a fast forward' });
        return;
      }
      repo.git.refs.set(fullRef, newSha);
      repo.git.bumpVersion();
      sendJson(res, 200, {
        ref: fullRef,
        object: { sha: newSha, type: 'commit' },
      });
      return;
    }

    if (method === 'DELETE') {
      if (!repo.git.refs.has(fullRef)) {
        sendJsonBuf(res, 404, ERR_404_BUF);
        return;
      }
      repo.git.refs.delete(fullRef);
      repo.git.bumpVersion();
      sendJson(res, 204, null);
      return;
    }
  }

  // 4. Commits API: GET /commits?sha=...
  if (subPath === '/commits' && method === 'GET') {
    const params = new URLSearchParams(rawQuery);
    const shaParam = params.get('sha');
    const perPage = Math.min(100, Math.max(1, parseInt(params.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);

    const allCommits = store.listCommits(repo, shaParam, page * perPage + 1);
    if (allCommits === null) {
      sendJsonBuf(res, 404, ERR_404_BUF);
      return;
    }
    const start = (page - 1) * perPage;
    const slice = allCommits.slice(start, start + perPage);
    sendJson(res, 200, slice);
    return;
  }

  // 5. Contents API: GET / PUT / DELETE /contents[/*path]
  if (subPath === '/contents' || subPath.startsWith('/contents/')) {
    const rawFilePath = subPath === '/contents' ? '' : subPath.slice('/contents/'.length);
    const filePath = rawFilePath
      .split('/')
      .filter((s) => s.length > 0)
      .map(safeDecodeSegment)
      .join('/');

    if (method === 'GET') {
      const params = new URLSearchParams(rawQuery);
      const refParam = params.get('ref');
      const found = store.readContentAtPath(repo, filePath, refParam);
      if (found.kind === 'not_found') {
        sendJsonBuf(res, 404, ERR_404_BUF);
        return;
      }
      if (found.kind === 'dir') {
        sendJson(res, 200, found.items);
        return;
      }
      sendJson(res, 200, found.data);
      return;
    }

    if (method === 'PUT') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      const body = parsed.value as Record<string, unknown>;
      if (typeof body.content !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed: content (base64) is required' });
        return;
      }
      const resPut = store.putFileContent(repo, filePath, {
        message: typeof body.message === 'string' ? body.message : `Update ${filePath}`,
        contentBase64: body.content,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (!resPut.ok) {
        sendJson(res, resPut.status, { message: resPut.message });
        return;
      }
      const baseName = filePath.split('/').pop() ?? filePath;
      sendJson(res, resPut.status, {
        content: {
          name: baseName,
          path: filePath,
          sha: resPut.fileSha,
          size: resPut.fileSize,
          type: 'file',
          encoding: 'base64',
        },
        commit: {
          sha: resPut.commitSha,
          message: typeof body.message === 'string' ? body.message : `Update ${filePath}`,
        },
      });
      return;
    }

    if (method === 'DELETE') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      const body = parsed.value as Record<string, unknown>;
      const resDel = store.deleteFileContent(repo, filePath, {
        message: typeof body.message === 'string' ? body.message : `Delete ${filePath}`,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
      });
      if (!resDel.ok) {
        sendJson(res, resDel.status, { message: resDel.message });
        return;
      }
      sendJson(res, 200, {
        content: null,
        commit: {
          sha: resDel.commitSha,
          message: typeof body.message === 'string' ? body.message : `Delete ${filePath}`,
        },
      });
      return;
    }
  }

  // 6. Labels API: GET / POST /labels
  if (subPath === '/labels') {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()]);
      return;
    }
    if (method === 'POST') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      const body = parsed.value as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        sendJson(res, 422, { message: 'Validation Failed: label name is required' });
        return;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: `Label ${name} already exists` });
        return;
      }
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      const item = { name, color };
      repo.labels.set(name, item);
      sendJson(res, 201, item);
      return;
    }
  }

  // 7. Issues 列表、过滤与排序: GET /issues
  if (subPath === '/issues' && method === 'GET') {
    const params = new URLSearchParams(rawQuery);
    const stateFilter = (params.get('state') ?? 'open').toLowerCase();
    const direction = (params.get('direction') ?? 'desc').toLowerCase();
    const perPage = Math.min(100, Math.max(1, parseInt(params.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);

    const filtered = repo.issuesList.filter((i) => {
      if (stateFilter === 'all') return true;
      return i.state === stateFilter;
    });

    if (direction === 'asc') {
      filtered.sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.number - b.number));
    } else {
      filtered.sort((a, b) => (b.createdAtMs - a.createdAtMs) || (b.number - a.number));
    }

    const start = (page - 1) * perPage;
    const slice = filtered.slice(start, start + perPage);
    const linkHdr = buildPaginationLinkHeader(req, pathname, params, page, perPage, filtered.length);
    const rawArrayBuf = Buffer.from(
      `[${slice.map((i) => i.restJsonBuf.toString('utf8')).join(',')}]`,
      'utf8',
    );
    sendJsonBuf(res, 200, rawArrayBuf, linkHdr);
    return;
  }

  // 8. 单条 Issue 修改与 Comments: /issues/:number[/comments]
  const issueSubMatch = subPath.match(/^\/issues\/(\d+)(?:\/(comments))?$/);
  if (issueSubMatch) {
    const issueNum = parseInt(issueSubMatch[1], 10);
    const subAction = issueSubMatch[2];
    const issue = repo.issuesByNumber[issueNum];
    if (!issue) {
      sendJsonBuf(res, 404, ERR_404_BUF);
      return;
    }

    if (!subAction) {
      if (method === 'GET') {
        const sock = res.socket;
        if (sock?.cork) sock.cork();
        res.writeHead(200, issue.restHeaders);
        res.end(issue.restJsonBuf);
        if (sock?.uncork) sock.uncork();
        return;
      }
      if (method === 'PATCH') {
        const parsed = await readJsonObject(req);
        if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
          sendJsonBuf(res, 400, ERR_400_JSON_BUF);
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        const updated = store.updateIssue(repo, issue, {
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
          state: typeof body.state === 'string' ? body.state.toLowerCase() : undefined,
        });
        sendJsonBuf(res, 200, updated.restJsonBuf);
        return;
      }
    }

    if (subAction === 'comments') {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments);
        return;
      }
      if (method === 'POST') {
        const parsed = await readJsonObject(req);
        if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
          sendJsonBuf(res, 400, ERR_400_JSON_BUF);
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        if (typeof body.body !== 'string') {
          sendJson(res, 422, { message: 'Comment body is required' });
          return;
        }
        const comment = store.addComment(repo, issue, body.body);
        sendJson(res, 201, comment);
        return;
      }
    }
  }

  // 9. Pull Requests API: GET / POST /pulls
  if (subPath === '/pulls') {
    if (method === 'GET') {
      const params = new URLSearchParams(rawQuery);
      const stateFilter = (params.get('state') ?? 'open').toLowerCase();
      const direction = (params.get('direction') ?? 'desc').toLowerCase();
      const perPage = Math.min(100, Math.max(1, parseInt(params.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);

      const filtered = repo.pullsList.filter((pr) => {
        if (stateFilter === 'all') return true;
        return pr.state === stateFilter;
      });

      if (direction === 'asc') {
        filtered.sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.number - b.number));
      } else {
        filtered.sort((a, b) => (b.createdAtMs - a.createdAtMs) || (b.number - a.number));
      }

      const start = (page - 1) * perPage;
      const slice = filtered.slice(start, start + perPage).map((pr) => serializePullRest(repo, pr));
      const linkHdr = buildPaginationLinkHeader(req, pathname, params, page, perPage, filtered.length);
      sendJson(res, 200, slice, linkHdr);
      return;
    }

    if (method === 'POST') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      const body = parsed.value as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const head = typeof body.head === 'string' ? body.head.trim() : '';
      const base = typeof body.base === 'string' ? body.base.trim() : '';
      if (!title || !head || !base) {
        sendJson(res, 422, { message: 'Validation Failed: title, head, and base are required' });
        return;
      }
      const created = store.createPullRequest(repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        head,
        base,
      });
      if (!created.ok) {
        sendJson(res, created.status, { message: created.message });
        return;
      }
      sendJson(res, 201, serializePullRest(repo, created.pull));
      return;
    }
  }

  // 10. 单条 Pull Request: /pulls/:number[/files | /merge]
  const prSubMatch = subPath.match(/^\/pulls\/(\d+)(?:\/(files|merge))?$/);
  if (prSubMatch) {
    const prNum = parseInt(prSubMatch[1], 10);
    const prAction = prSubMatch[2];
    const pr = repo.pullsByNumber.get(prNum);
    if (!pr) {
      sendJsonBuf(res, 404, ERR_404_BUF);
      return;
    }

    if (!prAction) {
      if (method === 'GET') {
        sendJson(res, 200, serializePullRest(repo, pr));
        return;
      }
      if (method === 'PATCH') {
        const parsed = await readJsonObject(req);
        if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
          sendJsonBuf(res, 400, ERR_400_JSON_BUF);
          return;
        }
        const body = parsed.value as Record<string, unknown>;
        if (typeof body.title === 'string') pr.title = body.title;
        if (typeof body.body === 'string') pr.body = body.body;
        if (body.state === 'closed' || body.state === 'open') pr.state = body.state;
        sendJson(res, 200, serializePullRest(repo, pr));
        return;
      }
    }

    if (prAction === 'files' && method === 'GET') {
      const files = store.getPullFiles(repo, pr);
      sendJson(res, 200, files);
      return;
    }

    if (prAction === 'merge' && method === 'PUT') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        sendJsonBuf(res, 400, ERR_400_JSON_BUF);
        return;
      }
      const body = parsed.value as Record<string, unknown>;
      const rawMethod = typeof body.merge_method === 'string' ? body.merge_method.toLowerCase() : 'merge';
      const mergeMethod: 'merge' | 'squash' | 'rebase' =
        rawMethod === 'squash' ? 'squash' : rawMethod === 'rebase' ? 'rebase' : 'merge';
      const commitTitle = typeof body.commit_title === 'string' ? body.commit_title : undefined;

      const merged = store.mergePullRequest(repo, pr, mergeMethod, commitTitle);
      if (!merged.ok) {
        sendJson(res, merged.status, { message: merged.message, merged: false });
        return;
      }
      sendJson(res, 200, {
        sha: merged.sha,
        merged: true,
        message: 'Pull Request successfully merged',
      });
      return;
    }
  }

  sendJsonBuf(res, 404, ERR_404_BUF);
}
