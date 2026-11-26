import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGeminiPlanUsage } from './useGeminiPlanUsage';

const SNAPSHOT = {
  status: 'ok',
  fetchedAt: 1_790_000_000_000,
  windows: [{ id: 'gemini-weekly', remainingPercent: 50 }, { id: '3p-5h', remainingPercent: 0 }],
};

function reply(command: string, snapshot: unknown) {
  window.updateGeminiPlanUsage?.(command.slice('get_gemini_plan_usage:'.length), JSON.stringify(snapshot));
}

afterEach(() => {
  vi.useRealTimers();
  delete window.sendToJava;
  delete window.updateGeminiPlanUsage;
});

describe('useGeminiPlanUsage', () => {
  it('discards the late reply from a closed panel', () => {
    const send = vi.fn();
    window.sendToJava = send;
    const first = renderHook(useGeminiPlanUsage);
    first.unmount();
    const second = renderHook(useGeminiPlanUsage);
    expect(send.mock.calls[0][0]).toMatch(/^get_gemini_plan_usage:\d+$/);
    expect(send.mock.calls[0][0]).not.toBe(send.mock.calls[1][0]);

    act(() => reply(send.mock.calls[0][0], SNAPSHOT));
    expect(second.result.current).toBeNull();
    act(() => reply(send.mock.calls[1][0], SNAPSHOT));
    expect(second.result.current).toEqual(SNAPSHOT);
  });

  it('routes concurrent requests to their own panel instances', () => {
    const send = vi.fn();
    window.sendToJava = send;
    const first = renderHook(useGeminiPlanUsage);
    const second = renderHook(useGeminiPlanUsage);

    act(() => reply(send.mock.calls[0][0], SNAPSHOT));
    expect(first.result.current).toEqual(SNAPSHOT);
    expect(second.result.current).toBeNull();
    act(() => reply(send.mock.calls[1][0], { status: 'unavailable', reasonCode: 'cli_missing' }));
    expect(second.result.current).toMatchObject({ status: 'unavailable', reasonCode: 'cli_missing' });
  });

  it('never promotes invalid or missing quota values to a success snapshot', () => {
    const send = vi.fn();
    window.sendToJava = send;
    const { result } = renderHook(useGeminiPlanUsage);
    act(() => reply(send.mock.calls[0][0], {
      ...SNAPSHOT,
      windows: [
        { id: '3p-5h', remainingPercent: null },
        { id: 'gemini-weekly', remainingPercent: '100' },
        { id: 'unknown', remainingPercent: 100 },
      ],
    }));
    expect(result.current).toEqual({ status: 'unavailable', reasonCode: 'query_failed' });
  });

  it('omits out-of-range reset dates and rejects an unrenderable fetch timestamp', () => {
    const send = vi.fn();
    window.sendToJava = send;
    const first = renderHook(useGeminiPlanUsage);
    act(() => reply(send.mock.calls[0][0], { ...SNAPSHOT, fetchedAt: 1e20 }));
    expect(first.result.current).toEqual({ status: 'unavailable', reasonCode: 'query_failed' });

    const second = renderHook(useGeminiPlanUsage);
    act(() => reply(send.mock.calls[1][0], {
      ...SNAPSHOT, windows: [{ ...SNAPSHOT.windows[0], resetsAt: 1e20 }],
    }));
    expect(second.result.current).toEqual({ ...SNAPSHOT, windows: [SNAPSHOT.windows[0]] });
  });

  it('leaves loading on refused bridge dispatch', () => {
    window.sendToJava = vi.fn(() => false);
    const { result } = renderHook(useGeminiPlanUsage);
    expect(result.current).toEqual({ status: 'unavailable', reasonCode: 'query_failed' });
  });

  it('times out if Java never replies, without polling or accepting the late response', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.sendToJava = send;
    const { result } = renderHook(useGeminiPlanUsage);
    act(() => vi.advanceTimersByTime(120_000));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => reply(send.mock.calls[0][0], SNAPSHOT));
    expect(result.current).toEqual({ status: 'unavailable', reasonCode: 'timeout' });
  });
});
