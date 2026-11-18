/**
 * 极速 HTTP/1.1 二进制响应帧预编译器 (v3.0.0)
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
 * 构建完整的 HTTP/1.1 Keep-Alive 二进制响应帧
 */
export function buildHttpFrame(
  status: number,
  contentType: string | null,
  body: Buffer | null,
  extraHeaderLines = '',
): Buffer {
  const st = STATUS_TEXT[status] ?? `${status} Response`;
  const reqId = nextFrameReqId();
  const bodyLen = body ? body.length : 0;

  let head = `HTTP/1.1 ${st}\r\n`;
  if (contentType) {
    head += `Content-Type: ${contentType}\r\n`;
  }
  head += `Content-Length: ${bodyLen}\r\nX-GitHub-Request-Id: r${reqId}\r\nConnection: keep-alive\r\n`;
  if (extraHeaderLines) {
    head += extraHeaderLines;
  }
  head += '\r\n';

  const headBuf = Buffer.from(head, 'utf8');
  if (!body || bodyLen === 0 || status === 204) {
    return headBuf;
  }
  const combined = Buffer.allocUnsafe(headBuf.length + bodyLen);
  headBuf.copy(combined, 0);
  body.copy(combined, headBuf.length);
  return combined;
}
