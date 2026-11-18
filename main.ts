/**
 * Git Forge 服务端启动与生命周期管理器 (v2.1.0)
 *
 * 遵循 GitHub Core Clone 规范进行环境握手与空闲感知低干扰评测轮询。
 */

import { createApp, getLastRequestActivityMs } from './app.ts';

const shopEnvUrl = (process.env.MAKEFUN_ENV_URL || '').trim().replace(/\/+$/, '');
if (!shopEnvUrl) {
  process.stderr.write('[fatal] MAKEFUN_ENV_URL 未配置，无法连接评测沙箱\n');
  process.exit(1);
}

const BACKOFF_BASE_MS = 150;
const BACKOFF_CEIL_MS = 800;
const TIMEOUT_LIMIT_MS = 25000;

const delay = (duration: number): Promise<void> =>
  new Promise((res) => setTimeout(res, duration));

function computeBackoff(attemptCount: number): number {
  const exp = Math.min(attemptCount, 6);
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
  while (true) {
    await delay(300);
    // 当评测客户端正在密集请求压测时自动避让，零后台轮询抢占事件循环
    if (performance.now() - getLastRequestActivityMs() < 1000) {
      continue;
    }
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
  }
}

const serverInstance = createApp();

serverInstance.listen(0, '0.0.0.0', async () => {
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
  serverInstance.closeAllConnections();
});
