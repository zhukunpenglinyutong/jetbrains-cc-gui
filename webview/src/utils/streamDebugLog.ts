/* eslint-disable no-console */

const MAX_STREAM_DEBUG_LINES = 2000;
const streamDebugLines: string[] = [];
let cachedLogPath: string | null = null;

export const STREAM_DEBUG_LOG_ENABLED_KEY = 'streamDebugLogEnabled';

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLine(args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const body = args.map(formatArg).join(' ');
  return `[${timestamp}] ${body}`;
}

function appendLine(line: string): void {
  streamDebugLines.push(line);
  if (streamDebugLines.length > MAX_STREAM_DEBUG_LINES) {
    streamDebugLines.splice(0, streamDebugLines.length - MAX_STREAM_DEBUG_LINES);
  }

  if (typeof window !== 'undefined' && typeof window.sendToJava === 'function') {
    try {
      window.sendToJava(`stream_debug_log:${line}`);
    } catch {
      // Best-effort persistence only.
    }
  }
}

export function isStreamDebugLogEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return localStorage.getItem(STREAM_DEBUG_LOG_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setStreamDebugLogEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(STREAM_DEBUG_LOG_ENABLED_KEY, enabled ? 'true' : 'false');
    if (!enabled) {
      clearStreamDebugLog();
    }
    window.dispatchEvent(new CustomEvent('streamDebugLogChanged', { detail: { enabled } }));
  } catch {
    // Best-effort persistence only.
  }
}

/** Structured streaming debug log with in-memory buffer and optional Java file sink. */
export function streamDebugLog(...args: unknown[]): void {
  if (!isStreamDebugLogEnabled()) {
    return;
  }
  const line = formatLine(args);
  console.log(...args);
  appendLine(line);
}

export function getStreamDebugLogText(): string {
  return streamDebugLines.join('\n');
}

export function clearStreamDebugLog(): void {
  streamDebugLines.length = 0;
}

export function getStreamDebugLogPath(): string | null {
  return cachedLogPath;
}

export function applyStreamDebugLogPath(payload: string | { path?: string | null }): void {
  try {
    const data = typeof payload === 'string' ? JSON.parse(payload) as { path?: string | null } : payload;
    cachedLogPath = typeof data?.path === 'string' && data.path.length > 0 ? data.path : null;
  } catch {
    cachedLogPath = null;
  }
}

export function requestStreamDebugLogPath(): void {
  if (typeof window !== 'undefined' && typeof window.sendToJava === 'function') {
    window.sendToJava('get_stream_debug_log_path:');
  }
}

export function openStreamDebugLogFile(): void {
  if (typeof window !== 'undefined' && typeof window.sendToJava === 'function') {
    window.sendToJava('open_stream_debug_log:');
  }
}

if (typeof window !== 'undefined') {
  window.getStreamDebugLogText = getStreamDebugLogText;
  window.clearStreamDebugLog = clearStreamDebugLog;
  window.updateStreamDebugLogPath = (json: string) => {
    applyStreamDebugLogPath(json);
  };
}
