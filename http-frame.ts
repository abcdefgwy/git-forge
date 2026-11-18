/**
 * 极速 HTTP/1.1 二进制响应帧预编译器 (v3.1.0)
 *
 * 将状态行、标准头、精确 Content-Length 与负载预编译为单一连续 Buffer，
 * 使热路径仅需单次 socket.write(frame) 系统调用即可完成响应。
 */

export const JSON_CT = 'application/json; charset=utf-8';
export const GIT_UPLOAD_ADV_CT = 'application/x-git-upload-pack-advertisement';
export const GIT_RECEIVE_ADV_CT = 'application/x-git-receive-pack-advertisement';
export const GIT_UPLOAD_RES_CT = 'application/x-git-upload-pack-result';
export const GIT_RECEIVE_RES_CT = 'application/x-git-receive-pack-result';

const STATUS_TEXT: Record<number, string> = {
  200: '200 OK',
  201: '201 Created',
  202: '202 Accepted',
  204: '204 No Content',
  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  405: '405 Method Not Allowed',
  409: '409 Conflict',
  422: '422 Unprocessable Entity',
  500: '500 Internal Server Error',
};

let frameSeq = 1;

export function nextFrameReqId(): number {
  frameSeq = (frameSeq + 1) & 0x3fffffff;
  if (frameSeq === 0) frameSeq = 1;
  return frameSeq;
}

/**
 * 构建完整的 HTTP/1.1 二进制响应帧（204 严格不带 Content-Length 与 body）
 */
export function buildHttpFrame(
  status: number,
  contentType: string | null,
  body: Buffer | null,
  extraHeaderLines = '',
  closeConn = false,
): Buffer {
  const st = STATUS_TEXT[status] ?? `${status} Response`;
  const connLine = closeConn ? 'Connection: close\r\n' : 'Connection: keep-alive\r\n';

  if (status === 204) {
    const head =
      `HTTP/1.1 204 No Content\r\nX-GitHub-Request-Id: r1\r\n${connLine}` +
      `${extraHeaderLines}\r\n`;
    return Buffer.from(head, 'latin1');
  }

  const bodyLen = body ? body.length : 0;
  let head = `HTTP/1.1 ${st}\r\n`;
  if (contentType) {
    head += `Content-Type: ${contentType}\r\n`;
  }
  head += `Content-Length: ${bodyLen}\r\nX-GitHub-Request-Id: r1\r\n${connLine}`;
  if (extraHeaderLines) {
    head += extraHeaderLines;
  }
  head += '\r\n';

  const headLen = Buffer.byteLength(head, 'latin1');
  if (!body || bodyLen === 0) {
    return Buffer.from(head, 'latin1');
  }
  const combined = Buffer.allocUnsafe(headLen + bodyLen);
  combined.write(head, 0, headLen, 'latin1');
  body.copy(combined, headLen);
  return combined;
}

export const HEALTHZ_HTTP_FRAME = buildHttpFrame(200, JSON_CT, Buffer.from('{"ok":true}', 'utf8'));
export const ERR_401_HTTP_FRAME = buildHttpFrame(
  401,
  JSON_CT,
  Buffer.from('{"message":"Requires authentication"}', 'utf8'),
);
export const ERR_404_HTTP_FRAME = buildHttpFrame(
  404,
  JSON_CT,
  Buffer.from('{"message":"Not Found"}', 'utf8'),
);
export const ERR_400_JSON_HTTP_FRAME = buildHttpFrame(
  400,
  JSON_CT,
  Buffer.from('{"message":"Problems parsing JSON"}', 'utf8'),
);
export const API_V3_ROOT_HTTP_FRAME = buildHttpFrame(
  200,
  JSON_CT,
  Buffer.from(
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
  ),
  'X-OAuth-Scopes: repo, read:org, user\r\n',
);
export const API_V3_META_HTTP_FRAME = buildHttpFrame(
  200,
  JSON_CT,
  Buffer.from(
    JSON.stringify({
      verifiable_password_authentication: false,
      installed_version: '3.14.0',
    }),
    'utf8',
  ),
);
export const EMPTY_204_HTTP_FRAME = buildHttpFrame(204, null, null);
export const EMPTY_202_HTTP_FRAME = buildHttpFrame(202, null, null);
