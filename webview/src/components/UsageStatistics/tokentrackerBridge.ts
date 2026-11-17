/**
 * Promise-based JCEF bridge client for the TokenTracker local usage server.
 *
 * The vendored tokentracker-dashboard was written for Tauri's `invoke()`; here
 * the same request/response semantics are implemented over the JetBrains
 * bridge: requests go out via `sendToJava(type, {…, requestId})`, the Java
 * TokenTrackerHandler answers by calling `window.onTokenTrackerResponse` with
 * `{requestId, ok, data|error}`, and this module correlates the two by
 * requestId (same pending-map pattern as `resolve_file_path` in utils/bridge).
 */
import { sendToJava } from '../../utils/bridge';
import { debugWarn } from '../../utils/debug';

interface PendingEntry {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingEntry>();
let responseHandlerInstalled = false;
let requestCounter = 0;

function installResponseHandler() {
  if (responseHandlerInstalled) {
    return;
  }
  window.onTokenTrackerResponse = (json: string) => {
    try {
      const data = JSON.parse(json) as { requestId?: string; ok?: boolean; data?: any; error?: string };
      const requestId = data.requestId;
      if (!requestId) {
        return;
      }
      const entry = pendingRequests.get(requestId);
      if (!entry) {
        return;
      }
      pendingRequests.delete(requestId);
      clearTimeout(entry.timeoutId);
      if (data.ok) {
        entry.resolve(data.data);
      } else {
        entry.reject(new Error(data.error || 'unknown error'));
      }
    } catch {
      // Ignore malformed responses from the backend, but keep them observable.
      debugWarn('[tokentrackerBridge] malformed response ignored:', json);
    }
  };
  responseHandlerInstalled = true;
}

/** True when running inside the JCEF webview with the Java bridge available. */
export function isTokenTrackerBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.sendToJava === 'function';
}

/**
 * Invoke a TokenTracker bridge command on the Java side and await its answer.
 * Rejects on backend error or when the answer does not arrive within timeoutMs.
 */
export function invokeTokenTracker<T>(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  if (!isTokenTrackerBridgeAvailable()) {
    return Promise.reject(new Error('TokenTracker bridge unavailable'));
  }
  installResponseHandler();
  const requestId = `tt-${Date.now()}-${++requestCounter}`;
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRequests.delete(requestId)) {
        reject(new Error(`${type} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timeoutId });
    sendToJava(type, { ...payload, requestId });
  });
}

// ---------------------------------------------------------------------------
// Typed wrappers matching the desktop app's Tauri command surface
// ---------------------------------------------------------------------------

export interface TtCliStatus {
  installed: boolean;
  binPath?: string;
  version?: string;
}

export interface TtServerStatus {
  running: boolean;
  port: number;
}

export function ttDetectCli(): Promise<TtCliStatus> {
  return invokeTokenTracker<TtCliStatus>('tt_detect_cli');
}

export function ttInstallCli(): Promise<{ installed: boolean }> {
  // npm install can take a while; the Java side caps it at 180s.
  return invokeTokenTracker<{ installed: boolean }>('tt_install_cli', {}, 200_000);
}

export function ttEnsureServer(): Promise<TtServerStatus> {
  // Includes a possible server spawn + readiness wait (Java caps at 30s).
  return invokeTokenTracker<TtServerStatus>('tt_ensure_server', {}, 60_000);
}

export interface TtProxyResult {
  /** Raw response body text (JSON) from the local server. */
  body: string;
}

export function ttProxy(
  method: string,
  path: string,
  headers: Record<string, string> | null,
  body: string | null,
): Promise<TtProxyResult> {
  return invokeTokenTracker<TtProxyResult>('tt_proxy', { method, path, headers, body }, 45_000);
}
