import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAM_DEBUG_LOG_ENABLED_KEY,
  clearStreamDebugLog,
  applyStreamDebugLogPath,
  getStreamDebugLogPath,
  getStreamDebugLogText,
  isStreamDebugLogEnabled,
  setStreamDebugLogEnabled,
  streamDebugLog,
} from './streamDebugLog';

describe('streamDebugLog', () => {
  beforeEach(() => {
    localStorage.clear();
    clearStreamDebugLog();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is disabled by default', () => {
    expect(isStreamDebugLogEnabled()).toBe(false);
  });

  it('does not log when disabled', () => {
    streamDebugLog('[STREAM-DBG] test');
    expect(console.log).not.toHaveBeenCalled();
    expect(getStreamDebugLogText()).toBe('');
  });

  it('logs to console and buffer when enabled', () => {
    setStreamDebugLogEnabled(true);
    streamDebugLog('[STREAM-DBG] enabled test');
    expect(console.log).toHaveBeenCalledOnce();
    expect(getStreamDebugLogText()).toContain('[STREAM-DBG] enabled test');
  });

  it('clears the buffer when disabled', () => {
    setStreamDebugLogEnabled(true);
    streamDebugLog('[STREAM-DBG] before disable');
    setStreamDebugLogEnabled(false);
    expect(localStorage.getItem(STREAM_DEBUG_LOG_ENABLED_KEY)).toBe('false');
    expect(getStreamDebugLogText()).toBe('');
  });

  it('stores the log path from backend payloads', () => {
    applyStreamDebugLogPath(JSON.stringify({ path: '/tmp/codemoss-stream-debug.log' }));
    expect(getStreamDebugLogPath()).toBe('/tmp/codemoss-stream-debug.log');
  });
});
