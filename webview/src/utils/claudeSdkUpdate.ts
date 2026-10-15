import type { InstallResult } from '../types/dependency';
import { sendBridgeEvent } from './bridge';

const CLAUDE_SDK_ID = 'claude-sdk';

export interface ClaudeSdkUpdateResult {
  success: boolean;
  installedVersion?: string;
  error?: string;
}

/** Host failure payloads may omit sdkId, and the Node.js check adds a readable message. */
type InstallResultPayload = Partial<InstallResult> & { message?: string };

let pendingUpdate: Promise<ClaudeSdkUpdateResult> | null = null;

/**
 * Asks the host to update the Claude SDK with the same `update_dependency`
 * request the Dependency settings page sends, and resolves with its result.
 *
 * Concurrent callers share one request so two cards cannot start parallel
 * npm installs into the same directory. The result handler is installed on
 * `window.dependencyInstallResult` only while the request is pending and chains
 * to the previous handler, like the settings page does while it is mounted.
 */
export function requestClaudeSdkUpdate(): Promise<ClaudeSdkUpdateResult> {
  if (pendingUpdate) {
    return pendingUpdate;
  }

  let resolveUpdate!: (result: ClaudeSdkUpdateResult) => void;
  const update = new Promise<ClaudeSdkUpdateResult>((resolve) => {
    resolveUpdate = resolve;
  });
  pendingUpdate = update;

  const previous = window.dependencyInstallResult;
  let settled = false;

  // The settings page may chain this handler while the request is pending and
  // restores it on unmount, so it must stay a pass-through after settling.
  const handleResult = (json: string) => {
    if (typeof previous === 'function') {
      try {
        previous(json);
      } catch (e) {
        console.error('[claudeSdkUpdate] Error in chained dependencyInstallResult:', e);
      }
    }
    if (settled) {
      return;
    }

    let payload: InstallResultPayload;
    try {
      payload = JSON.parse(json);
    } catch {
      return;
    }
    if (payload.sdkId !== undefined && payload.sdkId !== CLAUDE_SDK_ID) {
      return;
    }

    settle(payload.success
      ? { success: true, installedVersion: payload.installedVersion }
      : { success: false, error: payload.message ?? payload.error });
  };

  const settle = (result: ClaudeSdkUpdateResult) => {
    settled = true;
    if (pendingUpdate === update) {
      pendingUpdate = null;
    }
    if (window.dependencyInstallResult === handleResult) {
      window.dependencyInstallResult = previous;
    }
    resolveUpdate(result);
  };

  window.dependencyInstallResult = handleResult;
  if (!sendBridgeEvent('update_dependency', JSON.stringify({ id: CLAUDE_SDK_ID }))) {
    settle({ success: false });
  }

  return update;
}
