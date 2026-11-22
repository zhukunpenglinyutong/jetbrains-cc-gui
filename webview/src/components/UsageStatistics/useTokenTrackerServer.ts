import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isTokenTrackerBridgeAvailable,
  ttEnsureServer,
  ttInstallCli,
  type TtServerStatus,
} from './tokentrackerBridge';

/**
 * TokenTracker 本地服务状态机（移植自 desktop-cc-gui 的同名 hook，Tauri 调用
 * 换成 JCEF 桥接，并改为 ensure-first）：
 *
 *   checking ─→ ensure ─┬─ 服务已在运行 / 启动成功 ─→ ready
 *                       ├─ ensure 报 not_installed ─→ guide
 *                       ├─ ensure 报 outdated ──────→ installing（自动升级）─→ 再 ensure
 *                       └─ ensure 其他失败 ──────────→ error
 *
 * 不做单独的 CLI detect：服务可能已被其他客户端（桌面端等）启动，此时无需
 * 本地 CLI 即可使用；CLI 检测由 Java 侧 ensure 内部完成。
 *
 *   guide 态重试 / error 态重试：retry() → 重新 ensure。
 *   guide 态 install() → installing → ensure。
 *
 * 只在组件挂载期间做一次性 ensure，不做任何轮询。
 */
export type TokenTrackerServerState =
  | { status: 'checking' }
  | { status: 'guide' }
  | { status: 'installing' }
  | { status: 'starting' }
  | { status: 'ready'; port: number }
  | { status: 'error'; message: string };

const CLI_NOT_INSTALLED_ERROR = 'tokentracker_cli_not_installed';
const CLI_OUTDATED_ERROR = 'tokentracker_cli_outdated';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * ensure；若 Java 报 CLI 版本过旧，则安装固定版本后再 ensure 一次。
 * 升级失败不致命：Java 每个 IDE 会话只报一次 outdated，之后回退到旧 CLI / 旧服务，不会循环。
 */
export async function ensureServerWithUpgrade(onUpgrade: () => void): Promise<TtServerStatus> {
  try {
    return await ttEnsureServer();
  } catch (error) {
    if (!errorMessage(error).includes(CLI_OUTDATED_ERROR)) throw error;
    onUpgrade();
    await ttInstallCli().catch(() => undefined);
    return ttEnsureServer();
  }
}

/**
 * vite dev 浏览器预览时 /tt-dev 代理的目标端口。
 * 必须与 vite.config.ts 中 server.proxy['/tt-dev'] 的 target 端口保持一致。
 */
const TT_DEV_PREVIEW_PORT = 7680;

export function useTokenTrackerServer() {
  const [state, setState] = useState<TokenTrackerServerState>({
    status: 'checking',
  });
  // generation 令牌：卸载 / 新一轮触发后，丢弃在途异步结果（含 StrictMode 双跑）。
  const generationRef = useRef(0);

  const runEnsure = useCallback(async (generation: number) => {
    setState({ status: 'starting' });
    try {
      const server = await ensureServerWithUpgrade(() => {
        if (generationRef.current === generation) setState({ status: 'installing' });
      });
      if (generationRef.current !== generation) return;
      setState({ status: 'ready', port: server.port });
    } catch (error) {
      if (generationRef.current !== generation) return;
      const message = errorMessage(error);
      if (message.includes(CLI_NOT_INSTALLED_ERROR)) {
        setState({ status: 'guide' });
      } else {
        setState({ status: 'error', message });
      }
    }
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!isTokenTrackerBridgeAvailable()) {
      // vite dev 浏览器预览：transport 走 /tt-dev proxy，无需 CLI 检测。
      setState({ status: 'ready', port: TT_DEV_PREVIEW_PORT });
      return;
    }
    void runEnsure(generation);
  }, [runEnsure]);

  /** error 态重试 / guide 态重新检测：都直接重走 ensure。 */
  const retry = useCallback(() => {
    const generation = ++generationRef.current;
    void runEnsure(generation);
  }, [runEnsure]);

  /** guide 态一键安装：Java 侧执行固定 npm package，成功后重走 ensure。 */
  const install = useCallback(() => {
    const generation = ++generationRef.current;
    setState({ status: 'installing' });
    void ttInstallCli()
      .then(() => {
        if (generationRef.current !== generation) return;
        void runEnsure(generation);
      })
      .catch((error) => {
        if (generationRef.current !== generation) return;
        setState({ status: 'error', message: errorMessage(error) });
      });
  }, [runEnsure]);

  return { state, retry, install };
}
