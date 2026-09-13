import {
  isDependencyStatusResponse,
  requestFreshDependencyStatus,
  requestDependencyStatusUntilSettled,
  retryDependencyStatusRequest,
  settleDependencyStatusRequest,
  waitForBridge,
} from './bridgeStartup';

describe('bridge startup recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.sendToJava;
    delete window.__ccgOnBridgeReady;
    window.__dependencyStatusState = 'pending';
  });

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('bootstraps once when the bridge appears after the fast retry window', () => {
    const callback = vi.fn();
    waitForBridge(callback);
    const bridgeReady = window.__ccgOnBridgeReady;

    vi.advanceTimersByTime(6000);
    expect(callback).not.toHaveBeenCalled();

    window.sendToJava = vi.fn();
    bridgeReady?.();
    bridgeReady?.();
    vi.runOnlyPendingTimers();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(window.__ccgOnBridgeReady).toBeUndefined();
  });

  it('cancels bridge polling when the page is hidden', () => {
    const callback = vi.fn();
    waitForBridge(callback);

    window.dispatchEvent(new Event('pagehide'));
    window.sendToJava = vi.fn();
    vi.runOnlyPendingTimers();

    expect(callback).not.toHaveBeenCalled();
    expect(window.__ccgOnBridgeReady).toBeUndefined();
  });

  it('stops dependency status retries after a valid response', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    requestDependencyStatusUntilSettled();

    expect(sendToJava).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(sendToJava).toHaveBeenCalledTimes(2);

    settleDependencyStatusRequest('ready');
    vi.advanceTimersByTime(10000);

    expect(sendToJava).toHaveBeenCalledTimes(2);
  });

  it('stops dependency status retries after an explicit backend error', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    requestDependencyStatusUntilSettled();

    settleDependencyStatusRequest('error');
    vi.advanceTimersByTime(20000);

    expect(sendToJava).toHaveBeenCalledTimes(1);
    expect(window.__dependencyStatusState).toBe('error');
  });

  it('keeps a single dependency status loop when startup is requested twice', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;

    requestDependencyStatusUntilSettled();
    requestDependencyStatusUntilSettled();
    vi.advanceTimersByTime(2000);
    settleDependencyStatusRequest('ready');

    expect(sendToJava).toHaveBeenCalledTimes(2);
  });

  it('restarts dependency status polling as a single request loop', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    requestDependencyStatusUntilSettled();

    retryDependencyStatusRequest();
    vi.advanceTimersByTime(2000);
    settleDependencyStatusRequest('ready');
    vi.advanceTimersByTime(10000);

    expect(sendToJava).toHaveBeenCalledTimes(3);
  });

  it('queues one fresh request behind an active dependency status request', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    requestDependencyStatusUntilSettled();

    requestFreshDependencyStatus();
    requestFreshDependencyStatus();
    expect(sendToJava).toHaveBeenCalledTimes(1);

    settleDependencyStatusRequest('ready');
    await Promise.resolve();

    expect(sendToJava).toHaveBeenCalledTimes(2);
    expect(window.__dependencyStatusState).toBe('pending');
    settleDependencyStatusRequest('ready');
  });

  it('rejects backend error payloads as dependency status responses', () => {
    expect(isDependencyStatusResponse({ 'claude-sdk': { installed: true } })).toBe(true);
    expect(isDependencyStatusResponse({ success: false, error: 'unavailable' })).toBe(false);
    expect(isDependencyStatusResponse({ success: false, error: null })).toBe(false);
    expect(isDependencyStatusResponse(null)).toBe(false);
  });
});
