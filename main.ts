/**
 * Git Forge 服务端启动与生命周期管理器 (v1.2.0)
 *
 * 遵循 GitHub Core Clone 规范进行环境握手与评测生命周期监听，支持 GraphQL v4 评测引擎。
 */

import { createApp } from './app.ts';

const shopEnvUrl = (process.env.MAKEFUN_ENV_URL || '').trim().replace(/\/+$/, '');
if (!shopEnvUrl) {
  process.stderr.write('[fatal] MAKEFUN_ENV_URL 未配置，无法连接评测沙箱\n');
  process.exit(1);
}

const BACKOFF_BASE_MS = 200;
const BACKOFF_CEIL_MS = 1500;
const TIMEOUT_LIMIT_MS = 25000;

const delay = (duration: number): Promise<void> =>
  new Promise((res) => setTimeout(res, duration));

function computeBackoff(attemptCount: number): number {
  const exp = Math.min(attemptCount, 7);
  return Math.min(BACKOFF_CEIL_MS, BACKOFF_BASE_MS * Math.pow(2, exp));
}

async function announcePort(portNumber: number): Promise<boolean> {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(`${shopEnvUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: portNumber }),
        signal: AbortSignal.timeout(TIMEOUT_LIMIT_MS),
      });

      if (response.status === 200 || response.status === 409) {
        return true;
      }

      if (response.status === 400 || response.status === 405) {
        process.stderr.write(`[error] 握手被拒，状态码: ${response.status}\n`);
        process.exit(1);
      }
    } catch {
      // 容忍临时连接异常并进入退避重试
    }

    attempt += 1;
    await delay(computeBackoff(attempt));
  }
}

async function awaitTrialCompletion(): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(`${shopEnvUrl}/done`, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_LIMIT_MS),
      });

      if (res.status === 200) {
        const payload = (await res.json()) as { done?: boolean };
        if (payload.done === true) {
          return;
        }
      }
    } catch {
      // 轮询重试
    }

    attempt += 1;
    await delay(computeBackoff(attempt));
  }
}

const serverInstance = createApp();

serverInstance.listen(0, async () => {
  const boundAddress = serverInstance.address();
  if (!boundAddress || typeof boundAddress === 'string') {
    process.stderr.write('[fatal] 服务端口分配失败\n');
    process.exit(1);
  }

  await announcePort(boundAddress.port);
  await awaitTrialCompletion();

  serverInstance.close(() => {
    process.exit(0);
  });
});
