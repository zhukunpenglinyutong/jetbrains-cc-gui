import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOfficeDeskHover } from './useOfficeDeskHover';

afterEach(() => vi.useRealTimers());
describe('desk hover admission', () => {
  it('ignores brief visits and opens only the settled desk without pointer-driven updates', () => {
    vi.useFakeTimers(); const { result, unmount } = renderHook(useOfficeDeskHover);
    act(() => { result.current.inspect('a', 10, 20); vi.advanceTimersByTime(200); result.current.inspect('b', 30, 40); vi.advanceTimersByTime(239); });
    expect(result.current.preview).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const opened = result.current.preview;
    expect(opened).toEqual({ sourceKey: 'b', x: 30, y: 40 });
    act(() => { result.current.inspect('b', 60, 70); vi.advanceTimersByTime(500); });
    expect(result.current.preview).toBe(opened); unmount();
  });
  it('cancels delayed previews on scrolling, escape and disposal', () => {
    vi.useFakeTimers(); const { result, unmount } = renderHook(useOfficeDeskHover);
    act(() => { result.current.inspect('a', 10, 20); document.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(500); });
    expect(result.current.preview).toBeNull();
    act(() => { result.current.inspect('b', 10, 20); vi.advanceTimersByTime(240); });
    expect(result.current.preview?.sourceKey).toBe('b');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(result.current.preview).toBeNull();
    act(() => result.current.inspect('c', 1, 2)); unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
