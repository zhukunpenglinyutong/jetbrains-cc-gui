import type { InstallResult } from '../types/dependency';
import { sendBridgeEvent } from './bridge';

const CLAUDE_SDK_ID = 'claude-sdk';

/** npm gets three attempts of up to three minutes each; past this the host is not answering. */
export const CLAUDE_SDK_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;

export interface ClaudeSdkUpdateResult {
  success: boolean;
  installedVersion?: string;
  /** Version installed before the update, when there was one. */
  previousVersion?: string;
  /** Claude CLI override the plugin runs instead of the SDK, when one is set. */
  customCliPath?: string;
  error?: string;
  /** No result arrived within {@link CLAUDE_SDK_UPDATE_TIMEOUT_MS}. */
  timedOut?: boolean;
}

/** Update state shared by every diagnostic card, so a card that remounts still sees it. */
export interface ClaudeSdkUpdateSnapshot {
  updating: boolean;
  /** Last line npm printed for the running update. */
  progress?: string;
  lastResult?: ClaudeSdkUpdateResult;
  /** Date.now() when lastResult arrived. */
  completedAt?: number;
}

/** Host failure payloads may omit sdkId, and the Node.js check adds a readable message. */
type InstallResultPayload = Partial<InstallResult> & {
  message?: string;
  previousVersion?: string;
  customCliPath?: string;
};

interface InstallProgressPayload {
  sdkId?: string;
  log?: string;
}

type HostCallbackName = 'dependencyInstallResult' | 'dependencyInstallProgress';

let pendingUpdate: Promise<ClaudeSdkUpdateResult> | null = null;
let snapshot: ClaudeSdkUpdateSnapshot = { updating: false };
const listeners = new Set<() => void>();

function updateSnapshot(changes: Partial<ClaudeSdkUpdateSnapshot>) {
  snapshot = { ...snapshot, ...changes };
  listeners.forEach((listener) => listener());
}

export function subscribeClaudeSdkUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getClaudeSdkUpdateSnapshot(): ClaudeSdkUpdateSnapshot {
  return snapshot;
}

/**
 * Installs `onPayload` on a host callback, chained to the previous handler. The settings page
 * chains to whatever it finds on mount and restores it on unmount, so after release the handler
 * stays a pass-through instead of dropping payloads meant for the handlers before it.
 */
function chainHostCallback(name: HostCallbackName, onPayload: (json: string) => void): () => void {
  const previous = window[name];
  let active = true;
  const handler = (json: string) => {
    if (typeof previous === 'function') {
      try {
        previous(json);
      } catch (e) {
        console.error(`[claudeSdkUpdate] Error in chained ${name}:`, e);
      }
    }
    if (active) {
      onPayload(json);
    }
  };
  window[name] = handler;
  return () => {
    active = false;
    if (window[name] === handler) {
      window[name] = previous;
    }
  };
}

function parsePayload<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

const isForClaudeSdk = (sdkId: string | undefined) => sdkId === undefined || sdkId === CLAUDE_SDK_ID;

function toUpdateResult(payload: InstallResultPayload): ClaudeSdkUpdateResult {
  if (payload.success) {
    return {
      success: true,
      installedVersion: payload.installedVersion,
      previousVersion: payload.previousVersion,
      customCliPath: payload.customCliPath,
    };
  }
  return { success: false, error: payload.message ?? payload.error };
}

/**
 * Asks the host to update the Claude SDK with the same `update_dependency`
 * request the Dependency settings page sends, and resolves with its result.
 *
 * Concurrent callers share one request so two cards cannot start parallel
 * npm installs. The result and progress handlers are installed only while the
 * request is pending, and the request gives up after
 * {@link CLAUDE_SDK_UPDATE_TIMEOUT_MS} so a lost reply cannot block retries.
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
  updateSnapshot({ updating: true, progress: undefined });

  let settled = false;
  const releaseCallbacks: Array<() => void> = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const settle = (result: ClaudeSdkUpdateResult) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    releaseCallbacks.forEach((release) => release());
    pendingUpdate = null;
    updateSnapshot({ updating: false, progress: undefined, lastResult: result, completedAt: Date.now() });
    resolveUpdate(result);
  };

  releaseCallbacks.push(chainHostCallback('dependencyInstallResult', (json) => {
    const payload = parsePayload<InstallResultPayload>(json);
    if (payload && isForClaudeSdk(payload.sdkId)) {
      settle(toUpdateResult(payload));
    }
  }));
  releaseCallbacks.push(chainHostCallback('dependencyInstallProgress', (json) => {
    const payload = parsePayload<InstallProgressPayload>(json);
    const line = payload?.log?.trim();
    if (line && isForClaudeSdk(payload?.sdkId)) {
      updateSnapshot({ progress: line });
    }
  }));
  timeout = setTimeout(() => settle({ success: false, timedOut: true }), CLAUDE_SDK_UPDATE_TIMEOUT_MS);

  if (!sendBridgeEvent('update_dependency', JSON.stringify({ id: CLAUDE_SDK_ID }))) {
    settle({ success: false });
  }

  return update;
}
