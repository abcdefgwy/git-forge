/**
 * Git Forge HTTP/1.1 服务核心路由层 (v4.0.0 - 裸 TCP Zero-Alloc 引擎)
 *
 * 彻底移除 node:http (IncomingMessage / ServerResponse / cork / uncork) 开销，
 * 基于 node:net + TCP_NODELAY 构建完整 HTTP/1.1 解析器与零分配快速直通路由：
 * - Fast Path 1: 2,000 次串行 GET issue 零字符串/零对象分配，单次 socket.write(restHttp200Frame)
 * - Fast Path 2: 200 次串行 POST issue 同步解析与单帧直写
 * - Clone: v0 & v2 全协议完整 HTTP/1.1 响应帧缓存
 * - Push: 零拷贝包解析 + 预编译 HTTP 响应帧
 */

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import {
  buildHttpFrame,
  API_V3_META_HTTP_FRAME,
  API_V3_ROOT_HTTP_FRAME,
  EMPTY_202_HTTP_FRAME,
  EMPTY_204_HTTP_FRAME,
  ERR_400_JSON_HTTP_FRAME,
  ERR_401_HTTP_FRAME,
  ERR_404_HTTP_FRAME,
  HEALTHZ_HTTP_FRAME,
  JSON_CT,
} from './http-frame.ts';
import { encodeCommit, isHex40, V2_UPLOAD_ADV_HTTP_FRAME } from './git-engine.ts';
import { handleGraphql, handleMcp } from './graphql-mcp.ts';
import {
  buildIssue201Frame,
  DEFAULT_VIEWER_EMAIL,
  DEFAULT_VIEWER_NAME,
  ForgeStore,
  serializePullRest,
  serializeRepoRest,
  type RepoRecord,
} from './store.ts';

export type AppServer = NetServer & {
  closeAllConnections(): void;
  closeIdleConnections(): void;
};

let activityTick = false;
let lastRequestActivityMs = performance.now();

export function getLastRequestActivityMs(): number {
  if (activityTick) {
    activityTick = false;
    lastRequestActivityMs = performance.now();
  }
  return lastRequestActivityMs;
}

const EMPTY_BUF = Buffer.alloc(0);
const CONTINUE_100_BUF = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
const GET_REPOS_PREFIX = Buffer.from('GET /api/v3/repos/', 'latin1');
const ISSUES_SEG_BUF = Buffer.from('/issues/', 'latin1');
const HTTP_11_CRLF = Buffer.from(' HTTP/1.1\r\n', 'latin1');
const CRLF_CRLF = Buffer.from('\r\n\r\n', 'latin1');
const CONN_CLOSE_LOWER = Buffer.from('\r\nconnection: close', 'latin1');
const CONN_CLOSE_TITLE = Buffer.from('\r\nConnection: close', 'latin1');

function parsePositiveInt(val: string | null | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function paginate<T>(items: T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return {
    slice: items.slice(start, start + perPage),
    totalPages,
  };
}

function buildLinkHeader(basePath: string, page: number, perPage: number, totalPages: number, host = '127.0.0.1:19999'): string {
  const links: string[] = [];
  const base = 'http://' + host + basePath;
  if (page < totalPages) {
    links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    links.push(`<${base}?page=${totalPages}&per_page=${perPage}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
    links.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
  }
  return links.join(', ');
}

function safeDecode(seg: string): string {
  if (seg.indexOf('%') === -1) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function parseQueryParams(queryStr: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!queryStr) return map;
  let start = 0;
  while (start <= queryStr.length) {
    const amp = queryStr.indexOf('&', start);
    const end = amp === -1 ? queryStr.length : amp;
    if (end > start) {
      const eq = queryStr.indexOf('=', start);
      if (eq === -1 || eq >= end) {
        map.set(safeDecode(queryStr.slice(start, end).replace(/\+/g, ' ')), '');
      } else {
        const k = safeDecode(queryStr.slice(start, eq).replace(/\+/g, ' '));
        const v = safeDecode(queryStr.slice(eq + 1, end).replace(/\+/g, ' '));
        map.set(k, v);
      }
    }
    if (amp === -1) break;
    start = amp + 1;
  }
  return map;
}

function parseChunkedBody(buf: Buffer, start: number): { body: Buffer; nextOffset: number } | null {
  let pos = start;
  let singleChunk: Buffer | null = null;
  let chunks: Buffer[] | null = null;
  let total = 0;

  while (true) {
    const lineEnd = buf.indexOf('\r\n', pos, 'latin1');
    if (lineEnd < 0) return null;
    const semi = buf.indexOf(0x3b, pos);
    const sizeEnd = semi >= 0 && semi < lineEnd ? semi : lineEnd;
    const hexStr = buf.toString('latin1', pos, sizeEnd).trim();
    const chunkSize = parseInt(hexStr, 16);
    if (!Number.isFinite(chunkSize) || chunkSize < 0) {
      throw new Error('Invalid chunk size');
    }
    pos = lineEnd + 2;
    if (chunkSize === 0) {
      while (true) {
        if (pos + 2 > buf.length) return null;
        if (buf[pos] === 13 && buf[pos + 1] === 10) {
          pos += 2;
          const body =
            singleChunk === null
              ? EMPTY_BUF
              : chunks === null
                ? singleChunk
                : Buffer.concat(chunks, total);
          return { body, nextOffset: pos };
        }
        const trailerEnd = buf.indexOf('\r\n', pos, 'latin1');
        if (trailerEnd < 0) return null;
        pos = trailerEnd + 2;
      }
    }
    if (pos + chunkSize + 2 > buf.length) return null;
    if (buf[pos + chunkSize] !== 13 || buf[pos + chunkSize + 1] !== 10) {
      throw new Error('Invalid chunk terminator');
    }
    const slice = buf.subarray(pos, pos + chunkSize);
    total += chunkSize;
    if (singleChunk === null) {
      singleChunk = slice;
    } else {
      if (chunks === null) chunks = [singleChunk];
      chunks.push(slice);
    }
    pos += chunkSize + 2;
  }
}

export function createApp(store = new ForgeStore()): AppServer {
  const configuredToken = (process.env.MAKEFUN_SHOP_TOKEN || '').trim();
  const expectedBearer = configuredToken ? `Bearer ${configuredToken}` : '';
  const expectedTokenAuth = configuredToken ? `token ${configuredToken}` : '';
  const expectedBearerLineUpper = configuredToken
    ? Buffer.from(`\r\nAuthorization: Bearer ${configuredToken}\r\n`, 'latin1')
    : null;
  const expectedBearerLineLower = configuredToken
    ? Buffer.from(`\r\nauthorization: bearer ${configuredToken}\r\n`, 'latin1')
    : null;
  const expectedBearerLineMixed = configuredToken
    ? Buffer.from(`\r\nauthorization: Bearer ${configuredToken}\r\n`, 'latin1')
    : null;

  // 单条目最近仓库缓存，配合 store.deleteCount 保持 100% 强一致
  let lastRepo: RepoRecord | null = null;
  let lastRepoDeleteGen = -1;

  const updateLastRepo = (repo: RepoRecord): void => {
    lastRepo = repo;
    lastRepoDeleteGen = store.deleteCount;
  };

  const checkAuth = (authHeader: string | undefined): boolean => {
    if (!authHeader) return false;
    if (configuredToken) {
      if (authHeader === expectedBearer || authHeader === expectedTokenAuth) return true;
      const trimmed = authHeader.trim();
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('bearer ')) return trimmed.slice(7).trim() === configuredToken;
      if (lower.startsWith('token ')) return trimmed.slice(6).trim() === configuredToken;
      return false;
    }
    return /^(?:Bearer|token)\s+\S+/i.test(authHeader);
  };

  const writeFrame = (socket: Socket, frame: Buffer, closeConn: boolean): void => {
    if (closeConn) {
      socket.end(frame);
    } else {
      socket.write(frame);
    }
  };

  const sendJson = (
    socket: Socket,
    closeConn: boolean,
    status: number,
    data: unknown,
    extraHeaderLines = '',
  ): void => {
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    writeFrame(socket, buildHttpFrame(status, JSON_CT, body, extraHeaderLines, closeConn), closeConn);
  };

  const sendError = (socket: Socket, closeConn: boolean, status: number, message: string): void => {
    if (!closeConn) {
      if (status === 401 && message === 'Requires authentication') {
        socket.write(ERR_401_HTTP_FRAME);
        return;
      }
      if (status === 404 && message === 'Not Found') {
        socket.write(ERR_404_HTTP_FRAME);
        return;
      }
    }
    sendJson(socket, closeConn, status, { message });
  };

  const parseJsonBody = (
    raw: Buffer,
  ): { ok: true; obj: Record<string, unknown> } | { ok: false } => {
    if (raw.length === 0) return { ok: true, obj: {} };
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false };
      }
      return { ok: true, obj: parsed as Record<string, unknown> };
    } catch {
      return { ok: false };
    }
  };

  const dispatchRequest = (
    socket: Socket,
    method: string,
    rawUrl: string,
    headers: Record<string, string>,
    rawBody: Buffer,
    closeConn: boolean,
  ): void => {
    const reqHost = headers.host || `127.0.0.1:${socket.localPort || 80}`;
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const queryStr = qIdx === -1 ? '' : rawUrl.slice(qIdx + 1);

    // 1. 健康检查
    if (method === 'GET' && pathname === '/healthz') {
      if (!closeConn) {
        socket.write(HEALTHZ_HTTP_FRAME);
      } else {
        writeFrame(
          socket,
          buildHttpFrame(200, JSON_CT, Buffer.from('{"ok":true}', 'utf8'), '', true),
          true,
        );
      }
      return;
    }

    // 2. REST API 极速热路径：GET/POST /api/v3/repos/:owner/:repo/issues(/:number)
    if (pathname.startsWith('/api/v3/repos/')) {
      const rest = pathname.slice(14);
      const s1 = rest.indexOf('/');
      if (s1 > 0) {
        const s2 = rest.indexOf('/', s1 + 1);
        if (s2 > s1 + 1) {
          const tail = rest.slice(s2 + 1);
          if (tail.startsWith('issues')) {
            const sub = tail.slice(6);
            if (sub === '' && method === 'POST') {
              if (!checkAuth(headers.authorization)) {
                sendError(socket, closeConn, 401, 'Requires authentication');
                return;
              }
              const owner = safeDecode(rest.slice(0, s1));
              const repoName = safeDecode(rest.slice(s1 + 1, s2));
              const repo = store.getRepo(owner, repoName);
              if (!repo) {
                sendError(socket, closeConn, 404, 'Not Found');
                return;
              }
              updateLastRepo(repo);
              const parsed = parseJsonBody(rawBody);
              if (!parsed.ok) {
                if (!closeConn) socket.write(ERR_400_JSON_HTTP_FRAME);
                else sendError(socket, true, 400, 'Problems parsing JSON');
                return;
              }
              const body = parsed.obj;
              if (typeof body.title !== 'string' || body.title.length === 0) {
                sendError(socket, closeConn, 422, 'Validation Failed: title is required');
                return;
              }
              const created = store.createIssue(repo, {
                title: body.title,
                body: typeof body.body === 'string' ? body.body : '',
                labelNames: Array.isArray(body.labels) ? body.labels : undefined,
              });
              if (!created.ok) {
                sendError(socket, closeConn, created.status, created.message);
                return;
              }
              if (!closeConn) {
                socket.write(buildIssue201Frame(created.issue));
              } else {
                writeFrame(
                  socket,
                  buildHttpFrame(201, JSON_CT, created.issue.restJsonBuf, '', true),
                  true,
                );
              }
              return;
            }
            if (sub.length > 1 && sub.charCodeAt(0) === 47 && method === 'GET') {
              const numStr = sub.slice(1);
              if (/^\d+$/.test(numStr)) {
                if (!checkAuth(headers.authorization)) {
                  sendError(socket, closeConn, 401, 'Requires authentication');
                  return;
                }
                const owner = safeDecode(rest.slice(0, s1));
                const repoName = safeDecode(rest.slice(s1 + 1, s2));
                const repo = store.getRepo(owner, repoName);
                if (!repo) {
                  sendError(socket, closeConn, 404, 'Not Found');
                  return;
                }
                updateLastRepo(repo);
                const issue = repo.issuesByNumber[Number(numStr)];
                if (!issue) {
                  sendError(socket, closeConn, 404, 'Not Found');
                  return;
                }
                if (!closeConn) {
                  socket.write(issue.restHttp200Frame);
                } else {
                  writeFrame(
                    socket,
                    buildHttpFrame(200, JSON_CT, issue.restJsonBuf, '', true),
                    true,
                  );
                }
                return;
              }
            }
          }
        }
      }
    }

    // 3. Git Smart HTTP: /:owner/:repo(.git)/(info/refs | git-upload-pack | git-receive-pack)
    if (
      pathname.charCodeAt(0) === 47 &&
      !pathname.startsWith('/api/') &&
      pathname !== '/graphql' &&
      pathname !== '/mcp'
    ) {
      let pStart = 1;
      while (pathname.charCodeAt(pStart) === 47) pStart++;
      const s1 = pathname.indexOf('/', pStart);
      const s2 = s1 > pStart ? pathname.indexOf('/', s1 + 1) : -1;
      if (s2 > s1 + 1 && s2 + 1 < pathname.length) {
        const ownerSeg = safeDecode(pathname.slice(pStart, s1));
        const rawRepoSeg = safeDecode(pathname.slice(s1 + 1, s2));
        const repoNameSeg = rawRepoSeg.endsWith('.git') ? rawRepoSeg.slice(0, -4) : rawRepoSeg;
        let gitAction = pathname.slice(s2 + 1);
        if (gitAction.endsWith('/')) gitAction = gitAction.replace(/\/+$/, '');

        if (
          gitAction === 'info/refs' ||
          gitAction === 'git-upload-pack' ||
          gitAction === 'git-receive-pack'
        ) {
          if (!checkAuth(headers.authorization)) {
            sendError(socket, closeConn, 401, 'Requires authentication');
            return;
          }
          const repo = store.getRepo(ownerSeg, repoNameSeg);
          if (!repo) {
            sendError(socket, closeConn, 404, 'Not Found');
            return;
          }
          const wantsV2 = (headers['git-protocol'] || '').includes('version=2');

          if (method === 'GET' && gitAction === 'info/refs') {
            const service = parseQueryParams(queryStr).get('service') || '';
            if (service === 'git-upload-pack') {
              if (!closeConn && wantsV2) {
                socket.write(V2_UPLOAD_ADV_HTTP_FRAME);
              } else if (!closeConn && !wantsV2) {
                socket.write(repo.git.buildUploadPackAdvV0HttpFrame());
              } else {
                const payload = wantsV2
                  ? V2_UPLOAD_ADV_HTTP_FRAME.subarray(V2_UPLOAD_ADV_HTTP_FRAME.indexOf('\r\n\r\n', 0, 'latin1') + 4)
                  : repo.git.buildUploadPackAdvV0();
                writeFrame(
                  socket,
                  buildHttpFrame(
                    200,
                    'application/x-git-upload-pack-advertisement',
                    payload,
                    'Cache-Control: no-cache\r\n',
                    true,
                  ),
                  true,
                );
              }
              return;
            }
            if (service === 'git-receive-pack') {
              if (!closeConn) {
                socket.write(repo.git.buildReceivePackAdvHttpFrame());
              } else {
                writeFrame(
                  socket,
                  buildHttpFrame(
                    200,
                    'application/x-git-receive-pack-advertisement',
                    repo.git.buildReceivePackAdv(),
                    'Cache-Control: no-cache\r\n',
                    true,
                  ),
                  true,
                );
              }
              return;
            }
            sendError(socket, closeConn, 403, 'Unsupported git service');
            return;
          }

          if (method === 'POST' && gitAction === 'git-upload-pack') {
            if (!closeConn) {
              socket.write(repo.git.handleUploadPackHttpFrame(rawBody, wantsV2));
            } else {
              const out = repo.git.handleUploadPack(rawBody, wantsV2);
              writeFrame(
                socket,
                buildHttpFrame(
                  200,
                  'application/x-git-upload-pack-result',
                  out,
                  'Cache-Control: no-cache\r\n',
                  true,
                ),
                true,
              );
            }
            return;
          }

          if (method === 'POST' && gitAction === 'git-receive-pack') {
            if (!closeConn) {
              socket.write(repo.git.handleReceivePackHttpFrame(rawBody));
            } else {
              const out = repo.git.handleReceivePack(rawBody);
              writeFrame(
                socket,
                buildHttpFrame(
                  200,
                  'application/x-git-receive-pack-result',
                  out,
                  'Cache-Control: no-cache\r\n',
                  true,
                ),
                true,
              );
            }
            return;
          }
        }
      }
    }

    // 以下所有端点均需鉴权
    if (!checkAuth(headers.authorization)) {
      sendError(socket, closeConn, 401, 'Requires authentication');
      return;
    }

    // 4. MCP JSON-RPC 2.0 (POST /mcp)
    if (pathname === '/mcp') {
      if (method !== 'POST') {
        sendError(socket, closeConn, 405, 'Method Not Allowed');
        return;
      }
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendJson(socket, closeConn, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }
      const resp = handleMcp(store, parsed.obj);
      if (resp === null) {
        if (!closeConn) socket.write(EMPTY_202_HTTP_FRAME);
        else writeFrame(socket, buildHttpFrame(202, null, null, '', true), true);
        return;
      }
      sendJson(socket, closeConn, 200, resp);
      return;
    }

    // 5. GraphQL v4 (POST /api/graphql | /graphql)
    if (pathname === '/api/graphql' || pathname === '/graphql') {
      if (method !== 'POST') {
        sendError(socket, closeConn, 405, 'Method Not Allowed');
        return;
      }
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJson(socket, closeConn, 400, { errors: [{ message: 'Invalid JSON body' }] });
        return;
      }
      if (typeof rawJson !== 'object' || rawJson === null) {
        sendJson(socket, closeConn, 400, { errors: [{ message: 'Invalid JSON body' }] });
        return;
      }
      if (Array.isArray(rawJson)) {
        const batchResults = rawJson.map((entry) =>
          typeof entry === 'object' && entry !== null
            ? handleGraphql(
                store,
                typeof (entry as Record<string, unknown>).query === 'string' ? ((entry as Record<string, unknown>).query as string) : '',
                (typeof (entry as Record<string, unknown>).variables === 'object' && (entry as Record<string, unknown>).variables !== null ? (entry as Record<string, unknown>).variables : {}) as Record<string, unknown>,
              )
            : { data: null, errors: [{ message: 'Invalid operation entry' }] },
        );
        sendJson(socket, closeConn, 200, batchResults);
        return;
      }
      const singleObj = rawJson as Record<string, unknown>;
      const query = typeof singleObj.query === 'string' ? singleObj.query : '';
      const variables =
        typeof singleObj.variables === 'object' && singleObj.variables !== null
          ? (singleObj.variables as Record<string, unknown>)
          : {};
      const result = handleGraphql(store, query, variables);
      sendJson(socket, closeConn, 200, result);
      return;
    }

    // 6. REST API v3 基础端点
    if (pathname === '/api/v3' || pathname === '/api/v3/') {
      if (!closeConn) {
        socket.write(API_V3_ROOT_HTTP_FRAME);
      } else {
        writeFrame(
          socket,
          buildHttpFrame(
            200,
            JSON_CT,
            API_V3_ROOT_HTTP_FRAME.subarray(API_V3_ROOT_HTTP_FRAME.indexOf('\r\n\r\n', 0, 'latin1') + 4),
            'X-OAuth-Scopes: repo, read:org, user\r\n',
            true,
          ),
          true,
        );
      }
      return;
    }

    if (pathname === '/api/v3/meta') {
      if (!closeConn) {
        socket.write(API_V3_META_HTTP_FRAME);
      } else {
        writeFrame(
          socket,
          buildHttpFrame(
            200,
            JSON_CT,
            API_V3_META_HTTP_FRAME.subarray(API_V3_META_HTTP_FRAME.indexOf('\r\n\r\n', 0, 'latin1') + 4),
            '',
            true,
          ),
          true,
        );
      }
      return;
    }

    if (pathname === '/api/v3/rate_limit') {
      const nowSec = Math.floor(Date.now() / 1000);
      const reset = nowSec + 3600;
      sendJson(socket, closeConn, 200, {
        resources: {
          core: { limit: 5000, remaining: 4999, reset, used: 1 },
          search: { limit: 30, remaining: 30, reset, used: 0 },
          graphql: { limit: 5000, remaining: 5000, reset, used: 0 },
        },
        rate: { limit: 5000, remaining: 4999, reset, used: 1 },
      });
      return;
    }

    if (pathname === '/api/v3/user') {
      sendJson(socket, closeConn, 200, {
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
      if (method === 'GET') {
        const qp = parseQueryParams(queryStr);
        const page = parsePositiveInt(qp.get('page'), 1);
        const perPage = Math.min(100, parsePositiveInt(qp.get('per_page'), 30));
        const allRepos = [...store.repos.values()].map(serializeRepoRest);
        const { slice, totalPages } = paginate(allRepos, page, perPage);
        const link = buildLinkHeader('/api/v3/user/repos', page, perPage, totalPages, reqHost);
        sendJson(socket, closeConn, 200, slice, link ? `Link: ${link}\r\n` : '');
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) {
          sendError(socket, closeConn, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.obj;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          sendError(socket, closeConn, 422, 'Validation Failed: name is required');
          return;
        }
        const resCreate = store.createRepo({
          name,
          isPrivate: Boolean(body.private),
          description: typeof body.description === 'string' ? body.description : '',
          defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
        });
        if (!resCreate.created) {
          sendError(socket, closeConn, 422, resCreate.reason);
          return;
        }
        sendJson(socket, closeConn, 201, serializeRepoRest(resCreate.repo));
        return;
      }
    }

    const userReposMatch = /^\/api\/v3\/users\/([^/]+)\/repos$/.exec(pathname);
    if (userReposMatch && method === 'GET') {
      const targetUser = safeDecode(userReposMatch[1]!);
      const qp = parseQueryParams(queryStr);
      const page = parsePositiveInt(qp.get('page'), 1);
      const perPage = Math.min(100, parsePositiveInt(qp.get('per_page'), 30));
      const matching = [...store.repos.values()]
        .filter((r) => r.owner === targetUser)
        .map(serializeRepoRest);
      const { slice, totalPages } = paginate(matching, page, perPage);
      const link = buildLinkHeader(pathname, page, perPage, totalPages, reqHost);
      sendJson(socket, closeConn, 200, slice, link ? `Link: ${link}\r\n` : '');
      return;
    }

    const orgReposMatch = /^\/api\/v3\/orgs\/([^/]+)\/repos$/.exec(pathname);
    if (orgReposMatch && method === 'POST') {
      const orgName = safeDecode(orgReposMatch[1]!);
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        sendError(socket, closeConn, 422, 'Validation Failed: name is required');
        return;
      }
      const resCreate = store.createRepo({
        owner: orgName,
        name,
        isPrivate: Boolean(body.private),
        description: typeof body.description === 'string' ? body.description : '',
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
      });
      if (!resCreate.created) {
        sendError(socket, closeConn, 422, resCreate.reason);
        return;
      }
      sendJson(socket, closeConn, 201, serializeRepoRest(resCreate.repo));
      return;
    }

    // 7. 仓库作用域 REST API: /api/v3/repos/:owner/:repo(/...)
    if (pathname.startsWith('/api/v3/repos/')) {
      const restPath = pathname.slice(14);
      const parts = restPath.split('/');
      if (parts.length >= 2) {
        const owner = safeDecode(parts[0]!);
        const repoName = safeDecode(parts[1]!);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendError(socket, closeConn, 404, 'Not Found');
          return;
        }
        const subParts = parts.slice(2);
        const qp = queryStr ? parseQueryParams(queryStr) : null;
        handleRepoSubroutes(
          socket,
          closeConn,
          method,
          rawBody,
          store,
          repo,
          subParts,
          pathname,
          qp,
          sendJson,
          sendError,
          parseJsonBody,
          writeFrame,
          reqHost,
        );
        return;
      }
    }

    sendError(socket, closeConn, 404, 'Not Found');
  };

  const sockets = new Set<Socket>();

  const server = createNetServer({ noDelay: true }, (socket) => {
    socket.setNoDelay(true);
    // 严禁调用 socket.cork()
    socket.setTimeout(65_000, () => {
      socket.end();
    });
    sockets.add(socket);

    let pending: Buffer | null = null;
    let sent100 = false;
    let cachedPrefix: Buffer | null = null;
    let cachedTail: Buffer | null = null;
    let cachedRepo: RepoRecord | null = null;
    let cachedRepoDelGen = -1;

    socket.on('error', () => {
      // 忽略客户端断开导致的 ECONNRESET / EPIPE
    });

    socket.on('close', () => {
      sockets.delete(socket);
      pending = null;
    });

    socket.on('data', (chunk: Buffer) => {
      activityTick = true;

      // TIER 0 ULTRA-FAST PATH: 同一 Keep-Alive 连接上连续 GET issue，仅 2 次定长 memcmp
      if (
        pending === null &&
        cachedPrefix !== null &&
        cachedTail !== null &&
        cachedRepo !== null &&
        cachedRepoDelGen === store.deleteCount
      ) {
        const pLen = cachedPrefix.length;
        const tLen = cachedTail.length;
        const dLen = chunk.length - pLen - tLen;
        if (
          dLen >= 1 &&
          dLen <= 7 &&
          chunk.compare(cachedPrefix, 0, pLen, 0, pLen) === 0 &&
          chunk.compare(cachedTail, 0, tLen, pLen + dLen, chunk.length) === 0
        ) {
          let num = 0;
          let ok = true;
          for (let i = pLen; i < pLen + dLen; i++) {
            const b = chunk[i]!;
            if (b < 48 || b > 57) {
              ok = false;
              break;
            }
            num = num * 10 + (b - 48);
          }
          if (ok && num > 0) {
            const issue = cachedRepo.issuesByNumber[num];
            socket.write(issue ? issue.restHttp200Frame : ERR_404_HTTP_FRAME);
            return;
          }
        }
      }

      // ULTRA-FAST PATH: 单包完整到达的 GET /api/v3/repos/:owner/:repo/issues/:number
      if (pending === null) {
        const len = chunk.length;
        if (
          len >= 48 &&
          chunk[len - 4] === 13 &&
          chunk[len - 3] === 10 &&
          chunk[len - 2] === 13 &&
          chunk[len - 1] === 10 &&
          chunk.compare(GET_REPOS_PREFIX, 0, 18, 0, 18) === 0
        ) {
          const spaceIdx = chunk.indexOf(0x20, 18);
          if (
            spaceIdx > 25 &&
            spaceIdx + 11 < len &&
            chunk.compare(HTTP_11_CRLF, 0, 11, spaceIdx, spaceIdx + 11) === 0
          ) {
            const firstHdrStart = spaceIdx + 11;
            const pathQ = chunk.indexOf(0x3f, 18);
            const pathPct = chunk.indexOf(0x25, 18);
            const noQueryOrPct =
              (pathQ === -1 || pathQ > spaceIdx) && (pathPct === -1 || pathPct > spaceIdx);
            const crlfCrlfIdx = chunk.indexOf(CRLF_CRLF, firstHdrStart);

            if (noQueryOrPct && crlfCrlfIdx === len - 4) {
              const slash1 = chunk.indexOf(0x2f, 18);
              const slash2 = slash1 > 18 && slash1 < spaceIdx ? chunk.indexOf(0x2f, slash1 + 1) : -1;
              if (
                slash2 > slash1 + 1 &&
                slash2 + 9 <= spaceIdx &&
                chunk.compare(ISSUES_SEG_BUF, 0, 8, slash2, slash2 + 8) === 0
              ) {
                let num = 0;
                let validDigits = true;
                for (let i = slash2 + 8; i < spaceIdx; i++) {
                  const b = chunk[i]!;
                  if (b < 48 || b > 57) {
                    validDigits = false;
                    break;
                  }
                  num = num * 10 + (b - 48);
                }

                if (
                  validDigits &&
                  num > 0 &&
                  chunk.indexOf(CONN_CLOSE_LOWER, firstHdrStart - 2) === -1 &&
                  chunk.indexOf(CONN_CLOSE_TITLE, firstHdrStart - 2) === -1
                ) {
                  const authOk =
                    (expectedBearerLineUpper !== null && chunk.indexOf(expectedBearerLineUpper, firstHdrStart - 2) !== -1) ||
                    (expectedBearerLineLower !== null && chunk.indexOf(expectedBearerLineLower, firstHdrStart - 2) !== -1) ||
                    (expectedBearerLineMixed !== null && chunk.indexOf(expectedBearerLineMixed, firstHdrStart - 2) !== -1);

                  if (authOk) {
                    let repo: RepoRecord | undefined;
                    const repoLen = slash2 - 18;
                    if (
                      lastRepo !== null &&
                      lastRepoDeleteGen === store.deleteCount &&
                      lastRepo.fullNameBuf.length === repoLen &&
                      chunk.compare(lastRepo.fullNameBuf, 0, repoLen, 18, slash2) === 0
                    ) {
                      repo = lastRepo;
                    } else {
                      const repoKey = chunk.toString('utf8', 18, slash2);
                      repo = store.repos.get(repoKey);
                      if (repo) updateLastRepo(repo);
                    }

                    if (!repo) {
                      socket.write(ERR_404_HTTP_FRAME);
                      return;
                    }
                    cachedPrefix = Buffer.from(chunk.subarray(0, slash2 + 8));
                    cachedTail = Buffer.from(chunk.subarray(spaceIdx));
                    cachedRepo = repo;
                    cachedRepoDelGen = store.deleteCount;
                    const issue = repo.issuesByNumber[num];
                    socket.write(issue ? issue.restHttp200Frame : ERR_404_HTTP_FRAME);
                    return;
                  }
                }
              }
            }
          }
        }
      }

      // 通用 HTTP/1.1 状态机循环（支持分片、chunked、Expect 100-continue、pipelining）
      const buf = pending === null ? chunk : Buffer.concat([pending, chunk]);
      pending = null;
      let offset = 0;

      while (offset < buf.length) {
        const hdrEnd = buf.indexOf('\r\n\r\n', offset, 'latin1');
        if (hdrEnd < 0) {
          if (buf.length - offset > 65_536) {
            socket.destroy();
            return;
          }
          pending = offset === 0 ? buf : Buffer.from(buf.subarray(offset));
          return;
        }

        const lineEnd = buf.indexOf('\r\n', offset, 'latin1');
        if (lineEnd < 0 || lineEnd > hdrEnd) {
          socket.destroy();
          return;
        }

        const reqLine = buf.toString('latin1', offset, lineEnd);
        const sp1 = reqLine.indexOf(' ');
        const sp2 = sp1 > 0 ? reqLine.indexOf(' ', sp1 + 1) : -1;
        if (sp1 <= 0 || sp2 <= sp1 + 1) {
          socket.destroy();
          return;
        }
        const method = reqLine.slice(0, sp1);
        const rawUrl = reqLine.slice(sp1 + 1, sp2);
        const httpVer = reqLine.slice(sp2 + 1);

        const headers: Record<string, string> = {};
        let pos = lineEnd + 2;
        while (pos < hdrEnd) {
          const nextCrLf = buf.indexOf('\r\n', pos, 'latin1');
          const endPos = nextCrLf === -1 || nextCrLf > hdrEnd ? hdrEnd : nextCrLf;
          const colon = buf.indexOf(0x3a, pos);
          if (colon > pos && colon < endPos) {
            const firstChar = buf[pos]! | 0x20;
            if (
              firstChar === 97 || // a: authorization, accept
              firstChar === 99 || // c: connection, content-length, content-type
              firstChar === 101 || // e: expect
              firstChar === 103 || // g: git-protocol
              firstChar === 104 || // h: host
              firstChar === 116 || // t: transfer-encoding
              firstChar === 117 || // u: user-agent
              firstChar === 120    // x: x-...
            ) {
              const k = buf.toString('latin1', pos, colon).trim().toLowerCase();
              const v = buf.toString('latin1', colon + 1, endPos).trim();
              headers[k] = v;
            }
          }
          pos = endPos + 2;
        }

        // 状态机备用直通缓存学习：无论客户端大小写与头顺序如何，第一次成功处理后立刻为该 socket 建立 Tier 0 直通
        if (
          cachedPrefix === null &&
          method === 'GET' &&
          rawUrl.startsWith('/api/v3/repos/')
        ) {
          const issuesIdx = rawUrl.indexOf('/issues/');
          if (issuesIdx > 14 && sp2 > sp1 + 1) {
            const numStr = rawUrl.slice(issuesIdx + 8);
            if (/^\d+$/.test(numStr)) {
              const rest = rawUrl.slice(14, issuesIdx);
              const slashMid = rest.indexOf('/');
              if (slashMid > 0) {
                const owner = safeDecode(rest.slice(0, slashMid));
                const repoName = safeDecode(rest.slice(slashMid + 1));
                const repo = store.getRepo(owner, repoName);
                if (repo && checkAuth(headers.authorization)) {
                  cachedPrefix = Buffer.from(buf.subarray(offset, offset + sp1 + 1 + issuesIdx + 8));
                  cachedTail = Buffer.from(buf.subarray(offset + sp2, hdrEnd + 4));
                  cachedRepo = repo;
                  cachedRepoDelGen = store.deleteCount;
                }
              }
            }
          }
        }

        if (!sent100 && headers.expect && headers.expect.toLowerCase() === '100-continue') {
          socket.write(CONTINUE_100_BUF);
          sent100 = true;
        }

        const te = headers['transfer-encoding']?.toLowerCase();
        const isChunked = te !== undefined && te.includes('chunked');
        const clStr = headers['content-length'];
        const contentLength = clStr !== undefined ? parseInt(clStr, 10) : 0;
        const connHdr = headers.connection?.toLowerCase();
        const closeConn =
          httpVer === 'HTTP/1.0' ? connHdr !== 'keep-alive' : connHdr === 'close';

        const bodyStart = hdrEnd + 4;
        let rawBody: Buffer;
        let nextOffset: number;

        if (isChunked) {
          let parsedChunk: { body: Buffer; nextOffset: number } | null;
          try {
            parsedChunk = parseChunkedBody(buf, bodyStart);
          } catch {
            socket.destroy();
            return;
          }
          if (parsedChunk === null) {
            pending = offset === 0 ? buf : Buffer.from(buf.subarray(offset));
            return;
          }
          rawBody = parsedChunk.body;
          nextOffset = parsedChunk.nextOffset;
        } else if (Number.isFinite(contentLength) && contentLength > 0) {
          if (buf.length < bodyStart + contentLength) {
            pending = offset === 0 ? buf : Buffer.from(buf.subarray(offset));
            return;
          }
          rawBody = buf.subarray(bodyStart, bodyStart + contentLength);
          nextOffset = bodyStart + contentLength;
        } else {
          rawBody = EMPTY_BUF;
          nextOffset = bodyStart;
        }

        sent100 = false;
        offset = nextOffset;

        dispatchRequest(socket, method, rawUrl, headers, rawBody, closeConn);
        if (closeConn) {
          return;
        }
      }
    });
  }) as AppServer;

  server.closeAllConnections = () => {
    for (const s of sockets) {
      s.destroy();
    }
  };
  server.closeIdleConnections = () => {
    for (const s of sockets) {
      s.destroy();
    }
  };

  return server;
}

function handleRepoSubroutes(
  socket: Socket,
  closeConn: boolean,
  method: string,
  rawBody: Buffer,
  store: ForgeStore,
  repo: RepoRecord,
  sub: string[],
  pathname: string,
  qp: Map<string, string> | null,
  sendJson: (socket: Socket, closeConn: boolean, status: number, data: unknown, extraHeaders?: string) => void,
  sendError: (socket: Socket, closeConn: boolean, status: number, message: string) => void,
  parseJsonBody: (raw: Buffer) => { ok: true; obj: Record<string, unknown> } | { ok: false },
  writeFrame: (socket: Socket, frame: Buffer, closeConn: boolean) => void,
  reqHost = '127.0.0.1:19999',
): void {
  const getParam = (k: string): string | null => qp?.get(k) ?? null;

  if (sub.length === 0) {
    if (method === 'GET') {
      sendJson(socket, closeConn, 200, serializeRepoRest(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string') {
        repo.default_branch = body.default_branch;
        repo.git.defaultBranch = body.default_branch;
      }
      sendJson(socket, closeConn, 200, serializeRepoRest(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      if (!closeConn) socket.write(EMPTY_204_HTTP_FRAME);
      else writeFrame(socket, buildHttpFrame(204, null, null, '', true), true);
      return;
    }
  }

  const s0 = sub[0];

  // --- Contents ---
  if (s0 === 'contents') {
    const filePath = sub.slice(1).map(safeDecode).join('/');
    if (method === 'GET') {
      const refParam = getParam('ref');
      const result = store.readContentAtPath(repo, filePath, refParam);
      if (result.kind === 'not_found') {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }
      sendJson(socket, closeConn, 200, result.kind === 'dir' ? result.items : result.data);
      return;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      if (typeof body.content !== 'string' || typeof body.message !== 'string') {
        sendError(socket, closeConn, 422, 'Validation Failed: message and content are required');
        return;
      }
      const putRes = store.putFileContent(repo, filePath, {
        message: body.message,
        contentBase64: body.content,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (!putRes.ok) {
        sendError(socket, closeConn, putRes.status, putRes.message);
        return;
      }
      sendJson(socket, closeConn, putRes.status, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: putRes.fileSha,
          size: putRes.fileSize,
          type: 'file',
          encoding: 'base64',
        },
        commit: {
          sha: putRes.commitSha,
          message: body.message,
        },
      });
      return;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      const delRes = store.deleteFileContent(repo, filePath, {
        message: typeof body.message === 'string' ? body.message : `Delete ${filePath}`,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
      });
      if (!delRes.ok) {
        sendError(socket, closeConn, delRes.status, delRes.message);
        return;
      }
      sendJson(socket, closeConn, 200, {
        content: null,
        commit: { sha: delRes.commitSha },
      });
      return;
    }
  }

  // --- Branches ---
  if (s0 === 'branches') {
    if (sub.length === 1 && method === 'GET') {
      const branches = [];
      for (const [refName, sha] of repo.git.refs.entries()) {
        if (refName.startsWith('refs/heads/')) {
          branches.push({
            name: refName.slice(11),
            commit: { sha },
            protected: false,
          });
        }
      }
      sendJson(socket, closeConn, 200, branches);
      return;
    }
    if (sub.length >= 2 && method === 'GET') {
      const branchName = sub.slice(1).map(safeDecode).join('/');
      const sha = repo.git.refs.get(`refs/heads/${branchName}`);
      if (!sha) {
        sendError(socket, closeConn, 404, 'Branch not found');
        return;
      }
      sendJson(socket, closeConn, 200, {
        name: branchName,
        commit: { sha },
        protected: false,
      });
      return;
    }
  }

  // --- Commits ---
  if (s0 === 'commits') {
    if (sub.length === 1 && method === 'GET') {
      const shaParam = getParam('sha');
      const commits = store.listCommits(repo, shaParam);
      if (commits === null) {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }
      const page = parsePositiveInt(getParam('page'), 1);
      const perPage = Math.min(100, parsePositiveInt(getParam('per_page'), 30));
      const { slice } = paginate(commits, page, perPage);
      sendJson(socket, closeConn, 200, slice);
      return;
    }
    if (sub.length === 2 && method === 'GET') {
      const refOrSha = safeDecode(sub[1]!);
      const sha = store.resolveRevision(repo, refOrSha);
      if (!sha) {
        sendError(socket, closeConn, 404, 'No commit found');
        return;
      }
      const parsed = repo.git.getCommit(sha);
      if (!parsed) {
        sendError(socket, closeConn, 404, 'No commit found');
        return;
      }
      const exactMsg = repo.exactCommitMessages.get(sha) ?? parsed.message.replace(/\n$/, '');
      sendJson(socket, closeConn, 200, {
        sha,
        commit: { message: exactMsg, tree: { sha: parsed.tree } },
        parents: parsed.parents.map((p) => ({ sha: p })),
      });
      return;
    }
  }

  // --- Git Database API ---
  if (s0 === 'git') {
    if (sub[1] === 'refs' && method === 'GET') {
      const prefix = sub.length > 2 ? `refs/${sub.slice(2).map(safeDecode).join('/')}` : 'refs/';
      const out = [];
      for (const [refName, sha] of repo.git.refs.entries()) {
        if (refName.startsWith(prefix)) {
          const obj = repo.git.objects.get(sha);
          out.push({
            ref: refName,
            object: { sha, type: obj?.type ?? 'commit' },
          });
        }
      }
      sendJson(socket, closeConn, 200, out);
      return;
    }
    if (sub[1] === 'ref' && sub.length >= 3 && method === 'GET') {
      const targetRef = `refs/${sub.slice(2).map(safeDecode).join('/')}`;
      const sha = repo.git.refs.get(targetRef);
      if (!sha) {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }
      const obj = repo.git.objects.get(sha);
      sendJson(socket, closeConn, 200, {
        ref: targetRef,
        object: { sha, type: obj?.type ?? 'commit' },
      });
      return;
    }
    if (sub[1] === 'refs' && sub.length === 2 && method === 'POST') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      const refName = typeof body.ref === 'string' ? body.ref.trim() : '';
      const sha = typeof body.sha === 'string' ? body.sha.trim() : '';
      if (!refName.startsWith('refs/') || !isHex40(sha)) {
        sendError(socket, closeConn, 422, 'Validation Failed: invalid ref or sha');
        return;
      }
      if (!repo.git.objects.has(sha)) {
        sendError(socket, closeConn, 422, 'Validation Failed: target object does not exist');
        return;
      }
      if (repo.git.refs.has(refName)) {
        sendError(socket, closeConn, 422, `Reference ${refName} already exists`);
        return;
      }
      repo.git.refs.set(refName, sha);
      repo.git.bumpVersion();
      sendJson(socket, closeConn, 201, {
        ref: refName,
        object: { sha, type: repo.git.objects.get(sha)?.type ?? 'commit' },
      });
      return;
    }
    if (sub[1] === 'refs' && sub.length >= 3 && method === 'PATCH') {
      const targetRef = `refs/${sub.slice(2).map(safeDecode).join('/')}`;
      if (!repo.git.refs.has(targetRef)) {
        sendError(socket, closeConn, 404, 'Reference does not exist');
        return;
      }
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const sha = typeof parsed.obj.sha === 'string' ? parsed.obj.sha.trim() : '';
      if (!isHex40(sha) || !repo.git.objects.has(sha)) {
        sendError(socket, closeConn, 422, 'Invalid target sha');
        return;
      }
      repo.git.refs.set(targetRef, sha);
      repo.git.bumpVersion();
      sendJson(socket, closeConn, 200, {
        ref: targetRef,
        object: { sha, type: repo.git.objects.get(sha)?.type ?? 'commit' },
      });
      return;
    }
    if (sub[1] === 'refs' && sub.length >= 3 && method === 'DELETE') {
      const targetRef = `refs/${sub.slice(2).map(safeDecode).join('/')}`;
      if (!repo.git.refs.has(targetRef)) {
        sendError(socket, closeConn, 404, 'Reference does not exist');
        return;
      }
      repo.git.refs.delete(targetRef);
      repo.git.bumpVersion();
      if (!closeConn) socket.write(EMPTY_204_HTTP_FRAME);
      else writeFrame(socket, buildHttpFrame(204, null, null, '', true), true);
      return;
    }
    if (sub[1] === 'trees' && sub.length === 3 && method === 'GET') {
      const sha = safeDecode(sub[2]!);
      const entries = repo.git.getTree(sha);
      if (!entries) {
        sendError(socket, closeConn, 404, 'Tree not found');
        return;
      }
      sendJson(socket, closeConn, 200, {
        sha,
        tree: entries.map((e) => ({
          path: e.name,
          mode: e.mode === '40000' ? '040000' : e.mode,
          type: e.mode === '40000' ? 'tree' : 'blob',
          sha: e.oid,
        })),
      });
      return;
    }
    if (sub[1] === 'blobs' && sub.length === 3 && method === 'GET') {
      const sha = safeDecode(sub[2]!);
      const obj = repo.git.objects.get(sha);
      if (!obj || obj.type !== 'blob') {
        sendError(socket, closeConn, 404, 'Blob not found');
        return;
      }
      sendJson(socket, closeConn, 200, {
        sha,
        size: obj.data.length,
        encoding: 'base64',
        content: obj.data.toString('base64'),
      });
      return;
    }
    if (sub[1] === 'commits' && sub.length === 3 && method === 'GET') {
      const sha = safeDecode(sub[2]!);
      const parsed = repo.git.getCommit(sha);
      if (!parsed) {
        sendError(socket, closeConn, 404, 'Commit not found');
        return;
      }
      const exactMsg = repo.exactCommitMessages.get(sha) ?? parsed.message.replace(/\n$/, '');
      sendJson(socket, closeConn, 200, {
        sha,
        tree: { sha: parsed.tree },
        parents: parsed.parents.map((p) => ({ sha: p })),
        message: exactMsg,
      });
      return;
    }
    if (sub[1] === 'commits' && sub.length === 2 && method === 'POST') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      const tree = typeof body.tree === 'string' ? body.tree : '';
      const message = typeof body.message === 'string' ? body.message : 'Commit';
      const parents = Array.isArray(body.parents) ? body.parents.map(String) : [];
      if (!isHex40(tree)) {
        sendError(socket, closeConn, 422, 'Invalid tree sha');
        return;
      }
      const cBuf = encodeCommit({ tree, parents, message });
      const created = repo.git.putObject('commit', cBuf);
      repo.exactCommitMessages.set(created.oid, message);
      sendJson(socket, closeConn, 201, {
        sha: created.oid,
        tree: { sha: tree },
        parents: parents.map((p) => ({ sha: p })),
        message,
      });
      return;
    }
  }

  // --- Labels ---
  if (s0 === 'labels') {
    if (sub.length === 1 && method === 'GET') {
      sendJson(socket, closeConn, 200, [...repo.labels.values()]);
      return;
    }
    if (sub.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        sendError(socket, closeConn, 422, 'Validation Failed: name required');
        return;
      }
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      const item = { name, color };
      repo.labels.set(name, item);
      sendJson(socket, closeConn, 201, item);
      return;
    }
    if (sub.length === 2 && method === 'DELETE') {
      const name = safeDecode(sub[1]!);
      if (!repo.labels.has(name)) {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }
      repo.labels.delete(name);
      if (!closeConn) socket.write(EMPTY_204_HTTP_FRAME);
      else writeFrame(socket, buildHttpFrame(204, null, null, '', true), true);
      return;
    }
  }

  // --- Issues ---
  if (s0 === 'issues') {
    if (sub.length === 1 && method === 'GET') {
      const stateFilter = getParam('state') || 'open';
      const labelFilter = getParam('labels');
      const sinceParam = getParam('since');
      const sinceMs = sinceParam ? Date.parse(sinceParam) : NaN;
      const page = parsePositiveInt(getParam('page'), 1);
      const perPage = Math.min(100, parsePositiveInt(getParam('per_page'), 30));

      let filtered = repo.issuesList;
      if (stateFilter !== 'all') {
        filtered = filtered.filter((i) => i.state === stateFilter);
      }
      if (labelFilter) {
        const reqLabels = labelFilter
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        filtered = filtered.filter((i) => reqLabels.every((rl) => i.labels.some((il) => il.name === rl)));
      }
      if (!Number.isNaN(sinceMs)) {
        filtered = filtered.filter((i) => Date.parse(i.updated_at) >= sinceMs);
      }

      const direction = (getParam('direction') || 'desc').toLowerCase();
      filtered = [...filtered];
      if (direction === 'asc') {
        filtered.sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.number - b.number));
      } else {
        filtered.sort((a, b) => (b.createdAtMs - a.createdAtMs) || (b.number - a.number));
      }

      const { slice, totalPages } = paginate(filtered, page, perPage);
      const link = buildLinkHeader(pathname, page, perPage, totalPages, reqHost);
      const jsonArrayBuf = Buffer.concat([
        Buffer.from('['),
        ...slice.flatMap((it, idx) => (idx === 0 ? [it.restJsonBuf] : [Buffer.from(','), it.restJsonBuf])),
        Buffer.from(']'),
      ]);
      const extraHdr = link ? `Link: ${link}\r\n` : '';
      writeFrame(socket, buildHttpFrame(200, JSON_CT, jsonArrayBuf, extraHdr, closeConn), closeConn);
      return;
    }

    if (sub.length === 2) {
      const issueNum = Number(sub[1]);
      const issue = Number.isInteger(issueNum) ? repo.issuesByNumber[issueNum] : undefined;
      if (!issue) {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        if (!closeConn) {
          socket.write(issue.restHttp200Frame);
        } else {
          writeFrame(socket, buildHttpFrame(200, JSON_CT, issue.restJsonBuf, '', true), true);
        }
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) {
          sendError(socket, closeConn, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.obj;
        const updated = store.updateIssue(repo, issue, {
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
          state: typeof body.state === 'string' ? body.state : undefined,
        });
        if (!closeConn) {
          socket.write(updated.restHttp200Frame);
        } else {
          writeFrame(socket, buildHttpFrame(200, JSON_CT, updated.restJsonBuf, '', true), true);
        }
        return;
      }
    }

    if (sub.length === 3 && sub[2] === 'comments') {
      const issueNum = Number(sub[1]);
      const issue = Number.isInteger(issueNum) ? repo.issuesByNumber[issueNum] : undefined;
      if (!issue) {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(socket, closeConn, 200, issue.comments);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) {
          sendError(socket, closeConn, 400, 'Problems parsing JSON');
          return;
        }
        if (typeof parsed.obj.body !== 'string') {
          sendError(socket, closeConn, 422, 'Validation Failed: body is required');
          return;
        }
        const comment = store.addComment(repo, issue, parsed.obj.body);
        sendJson(socket, closeConn, 201, comment);
        return;
      }
    }
  }

  // --- Pull Requests ---
  if (s0 === 'pulls') {
    if (sub.length === 1 && method === 'GET') {
      const stateFilter = getParam('state') || 'open';
      const page = parsePositiveInt(getParam('page'), 1);
      const perPage = Math.min(100, parsePositiveInt(getParam('per_page'), 30));

      let list = repo.pullsList;
      if (stateFilter !== 'all') {
        list = list.filter((p) => p.state === stateFilter);
      }
      const { slice, totalPages } = paginate(list, page, perPage);
      const link = buildLinkHeader(pathname, page, perPage, totalPages, reqHost);
      sendJson(
        socket,
        closeConn,
        200,
        slice.map((p) => serializePullRest(repo, p)),
        link ? `Link: ${link}\r\n` : '',
      );
      return;
    }

    if (sub.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        sendError(socket, closeConn, 400, 'Problems parsing JSON');
        return;
      }
      const body = parsed.obj;
      if (
        typeof body.title !== 'string' ||
        typeof body.head !== 'string' ||
        typeof body.base !== 'string'
      ) {
        sendError(socket, closeConn, 422, 'Validation Failed: title, head, and base are required');
        return;
      }
      const title = (body.title as string).trim();
      const head = (body.head as string).trim();
      const base = (body.base as string).trim();
      if (!title || !head || !base) {
        sendError(socket, closeConn, 422, 'Validation Failed: title, head, and base are required');
        return;
      }
      const created = store.createPullRequest(repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        head,
        base,
      });
      if (!created.ok) {
        sendError(socket, closeConn, created.status, created.message);
        return;
      }
      sendJson(socket, closeConn, 201, serializePullRest(repo, created.pull));
      return;
    }

    if (sub.length === 2) {
      const prNum = parsePositiveInt(sub[1], -1);
      const pr = prNum > 0 ? repo.pullsByNumber.get(prNum) : undefined;
      if (!pr) {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }

      if (method === 'GET') {
        sendJson(socket, closeConn, 200, serializePullRest(repo, pr));
        return;
      }

      if (method === 'PATCH') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) {
          sendError(socket, closeConn, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.obj;
        if (typeof body.title === 'string') pr.title = body.title;
        if (typeof body.body === 'string') pr.body = body.body;
        if (body.state === 'closed' || body.state === 'open') pr.state = body.state;
        sendJson(socket, closeConn, 200, serializePullRest(repo, pr));
        return;
      }
    }

    if (sub.length === 3) {
      const prNum = parsePositiveInt(sub[1], -1);
      const pr = prNum > 0 ? repo.pullsByNumber.get(prNum) : undefined;
      if (!pr) {
        sendError(socket, closeConn, 404, 'Not Found');
        return;
      }

      const action = sub[2];
      if (action === 'files' && method === 'GET') {
        const files = store.getPullFiles(repo, pr);
        sendJson(socket, closeConn, 200, files);
        return;
      }

      if (action === 'merge' && method === 'PUT') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) {
          sendError(socket, closeConn, 400, 'Problems parsing JSON');
          return;
        }
        const body = parsed.obj;
        const rawMethod = typeof body.merge_method === 'string' ? body.merge_method.toLowerCase() : 'merge';
        const mergeMethod: 'merge' | 'squash' | 'rebase' =
          rawMethod === 'squash' ? 'squash' : rawMethod === 'rebase' ? 'rebase' : 'merge';
        const commitTitle = typeof body.commit_title === 'string' ? body.commit_title : undefined;

        const merged = store.mergePullRequest(repo, pr, mergeMethod, commitTitle);
        if (!merged.ok) {
          sendJson(socket, closeConn, merged.status, { message: merged.message, merged: false });
          return;
        }
        sendJson(socket, closeConn, 200, {
          sha: merged.sha,
          merged: true,
          message: 'Pull Request successfully merged',
        });
        return;
      }
    }
  }

  // 404 Not Found 兜底
  sendError(socket, closeConn, 404, 'Not Found');
}

