import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_SDK_UPDATE_TIMEOUT_MS,
  getClaudeSdkUpdateSnapshot,
  requestClaudeSdkUpdate,
  subscribeClaudeSdkUpdate,
} from './claudeSdkUpdate';

const respond = (payload: unknown) => window.dependencyInstallResult?.(JSON.stringify(payload));
const progress = (payload: unknown) => window.dependencyInstallProgress?.(JSON.stringify(payload));

describe('requestClaudeSdkUpdate', () => {
  let sendToJava: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    window.dependencyInstallResult = undefined;
    window.dependencyInstallProgress = undefined;
  });

  afterEach(() => {
    // Settle a request a test left pending so module state does not leak.
    respond({ success: false, sdkId: 'claude-sdk' });
    vi.useRealTimers();
    window.sendToJava = undefined;
    window.dependencyInstallResult = undefined;
    window.dependencyInstallProgress = undefined;
  });

  it('sends the same update request as the dependency settings page', () => {
    void requestClaudeSdkUpdate();
    expect(sendToJava).toHaveBeenCalledWith('update_dependency:{"id":"claude-sdk"}');
  });

  it('resolves with the installed version and gives the callback back', async () => {
    const previous = vi.fn();
    window.dependencyInstallResult = previous;

    const pending = requestClaudeSdkUpdate();
    respond({ success: true, sdkId: 'claude-sdk', installedVersion: '0.3.300' });

    await expect(pending).resolves.toEqual({ success: true, installedVersion: '0.3.300' });
    expect(previous).toHaveBeenCalledTimes(1);
    expect(window.dependencyInstallResult).toBe(previous);
  });

  it('shares one request between concurrent callers', () => {
    const first = requestClaudeSdkUpdate();
    const second = requestClaudeSdkUpdate();
    expect(second).toBe(first);
    expect(sendToJava).toHaveBeenCalledTimes(1);
  });

  it('reports the host message when Node.js is not configured', async () => {
    const pending = requestClaudeSdkUpdate();
    respond({
      success: false,
      sdkId: 'claude-sdk',
      error: 'node_not_configured',
      message: 'Node.js not configured. Please set Node.js path in Settings > Basic.',
    });

    await expect(pending).resolves.toEqual({
      success: false,
      error: 'Node.js not configured. Please set Node.js path in Settings > Basic.',
    });
  });

  it('treats a failure without sdkId as the result of the pending request', async () => {
    const pending = requestClaudeSdkUpdate();
    respond({ success: false, error: 'npm install failed with exit code: 1' });

    await expect(pending).resolves.toEqual({ success: false, error: 'npm install failed with exit code: 1' });
  });

  it('ignores results for other SDKs', async () => {
    let settled = false;
    const pending = requestClaudeSdkUpdate().then((result) => {
      settled = true;
      return result;
    });

    respond({ success: true, sdkId: 'codex-sdk', installedVersion: '0.155.0' });
    await Promise.resolve();
    expect(settled).toBe(false);

    respond({ success: true, sdkId: 'claude-sdk', installedVersion: '0.3.300' });
    await expect(pending).resolves.toEqual({ success: true, installedVersion: '0.3.300' });
  });

  it('fails right away when the bridge is not available and sends again on the next call', async () => {
    window.sendToJava = undefined;

    await expect(requestClaudeSdkUpdate()).resolves.toEqual({ success: false });
    expect(window.dependencyInstallResult).toBeUndefined();

    window.sendToJava = sendToJava;
    void requestClaudeSdkUpdate();
    expect(sendToJava).toHaveBeenCalledWith('update_dependency:{"id":"claude-sdk"}');
  });

  it('stays a pass-through when the settings page restores it after settling', async () => {
    const first = requestClaudeSdkUpdate();
    const firstHandler = window.dependencyInstallResult!;
    // The settings page mounts mid-request and chains to the saved handler.
    window.dependencyInstallResult = (json: string) => firstHandler(json);
    respond({ success: true, sdkId: 'claude-sdk', installedVersion: '0.3.300' });
    await expect(first).resolves.toEqual({ success: true, installedVersion: '0.3.300' });
    // On unmount it restores what it saved, which is the settled handler.
    window.dependencyInstallResult = firstHandler;

    const second = requestClaudeSdkUpdate();
    expect(second).not.toBe(first);
    expect(sendToJava).toHaveBeenCalledTimes(2);
    respond({ success: false, sdkId: 'claude-sdk', error: 'npm install failed' });

    await expect(second).resolves.toEqual({ success: false, error: 'npm install failed' });
    expect(window.dependencyInstallResult).toBe(firstHandler);
  });

  it('reports the previous version and the Claude CLI override from the host', async () => {
    const pending = requestClaudeSdkUpdate();
    respond({
      success: true,
      sdkId: 'claude-sdk',
      installedVersion: '0.3.300',
      previousVersion: '0.3.220',
      customCliPath: '/usr/local/bin/claude',
    });

    await expect(pending).resolves.toEqual({
      success: true,
      installedVersion: '0.3.300',
      previousVersion: '0.3.220',
      customCliPath: '/usr/local/bin/claude',
    });
  });

  it('shares the running update and its npm output with subscribers', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeClaudeSdkUpdate(listener);
    const previousProgress = vi.fn();
    window.dependencyInstallProgress = previousProgress;

    const pending = requestClaudeSdkUpdate();
    expect(getClaudeSdkUpdateSnapshot()).toMatchObject({ updating: true, progress: undefined });

    progress({ sdkId: 'claude-sdk', log: '  added 3 packages in 2s  ' });
    progress({ sdkId: 'codex-sdk', log: 'other sdk output' });
    progress({ sdkId: 'claude-sdk', log: '   ' });
    expect(getClaudeSdkUpdateSnapshot().progress).toBe('added 3 packages in 2s');
    expect(previousProgress).toHaveBeenCalledTimes(3);

    const before = Date.now();
    respond({ success: true, sdkId: 'claude-sdk', installedVersion: '0.3.300' });
    await pending;

    const snapshot = getClaudeSdkUpdateSnapshot();
    expect(snapshot.updating).toBe(false);
    expect(snapshot.progress).toBeUndefined();
    expect(snapshot.lastResult).toEqual({ success: true, installedVersion: '0.3.300' });
    expect(snapshot.completedAt).toBeGreaterThanOrEqual(before);
    expect(window.dependencyInstallProgress).toBe(previousProgress);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('gives up when no result arrives so the next call sends again', async () => {
    vi.useFakeTimers();
    const pending = requestClaudeSdkUpdate();

    vi.advanceTimersByTime(CLAUDE_SDK_UPDATE_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ success: false, timedOut: true });
    expect(window.dependencyInstallResult).toBeUndefined();
    expect(window.dependencyInstallProgress).toBeUndefined();

    void requestClaudeSdkUpdate();
    expect(sendToJava).toHaveBeenCalledTimes(2);
  });

  it('waits for a parsable result instead of settling on a malformed one', async () => {
    let settled = false;
    const pending = requestClaudeSdkUpdate().then((result) => {
      settled = true;
      return result;
    });

    window.dependencyInstallResult?.('not json');
    await Promise.resolve();
    expect(settled).toBe(false);

    respond({ success: true, sdkId: 'claude-sdk', installedVersion: '0.3.300' });
    await expect(pending).resolves.toEqual({ success: true, installedVersion: '0.3.300' });
  });
});
