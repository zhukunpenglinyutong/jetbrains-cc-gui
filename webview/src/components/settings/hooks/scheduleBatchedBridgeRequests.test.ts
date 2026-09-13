import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleBatchedBridgeRequests } from './scheduleBatchedBridgeRequests';

describe('scheduleBatchedBridgeRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first batch immediately and defers the rest', () => {
    const send = vi.fn();
    const messages = ['a:', 'b:', 'c:', 'd:', 'e:', 'f:', 'g:'];

    scheduleBatchedBridgeRequests({
      messages,
      batchSize: 3,
      batchDelayMs: 16,
      send,
    });

    expect(send.mock.calls.map((c) => c[0])).toEqual(['a:', 'b:', 'c:']);

    vi.advanceTimersByTime(16);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['a:', 'b:', 'c:', 'd:', 'e:', 'f:']);

    vi.advanceTimersByTime(16);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['a:', 'b:', 'c:', 'd:', 'e:', 'f:', 'g:']);
  });

  it('cancel stops deferred batches', () => {
    const send = vi.fn();
    const handle = scheduleBatchedBridgeRequests({
      messages: ['a:', 'b:', 'c:', 'd:'],
      batchSize: 2,
      batchDelayMs: 16,
      send,
    });

    expect(send).toHaveBeenCalledTimes(2);
    handle.cancel();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('no-ops for empty message lists', () => {
    const send = vi.fn();
    const handle = scheduleBatchedBridgeRequests({ messages: [], send });
    expect(send).not.toHaveBeenCalled();
    handle.cancel();
  });
});
