import { act, renderHook } from '@testing-library/react';
import { useLateBoundCallback } from './useLateBoundCallback.js';

/**
 * Story 1.3 review D2: the gemini model-change conversation reset is wired
 * through this trampoline (App passes `call` as `onSessionResetRequest` to
 * `useModelProviderState` — constructed BEFORE `useSessionManagement` — and
 * later points `set` at `forceCreateNewSession`). The hook half only pins
 * WHEN the callback fires; this test pins the trampoline contract the App
 * wiring relies on: stable identity, safe no-op before assignment, late
 * binding, and follow-the-latest re-assignment across renders.
 */
describe('useLateBoundCallback (Story 1.3 gemini session-reset trampoline)', () => {
  it('keeps call and set identity stable across renders', () => {
    const { result, rerender } = renderHook(() => useLateBoundCallback());
    const { call, set } = result.current;
    rerender();
    rerender();
    expect(result.current.call).toBe(call);
    expect(result.current.set).toBe(set);
  });

  it('is a safe no-op before the first assignment', () => {
    const { result } = renderHook(() => useLateBoundCallback());
    expect(() => result.current.call()).not.toThrow();
  });

  it('forwards to the assigned target with arguments', () => {
    const { result } = renderHook(() => useLateBoundCallback<[string, number]>());
    const target = vi.fn();

    act(() => {
      result.current.set(target);
    });
    act(() => {
      result.current.call('gemini-3.6-flash-high', 2);
    });

    expect(target).toHaveBeenCalledWith('gemini-3.6-flash-high', 2);
  });

  it('follows the latest target after re-assignment', () => {
    const { result } = renderHook(() => useLateBoundCallback());
    const first = vi.fn();
    const second = vi.fn();

    act(() => {
      result.current.set(first);
    });
    act(() => {
      result.current.set(second);
    });
    act(() => {
      result.current.call();
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('supports the App render-time assignment pattern: set during render, call sees the latest target', () => {
    // App.tsx assigns `geminiSessionReset.set(forceCreateNewSession)` in the
    // render body on every render — the trampoline must deliver the target
    // from the SAME render onward.
    const targetA = vi.fn();
    const targetB = vi.fn();
    let current = targetA;
    const { result, rerender } = renderHook(() => {
      const trampoline = useLateBoundCallback();
      trampoline.set(current); // render-time assignment (no useEffect mirror)
      return trampoline;
    });

    act(() => {
      result.current.call();
    });
    expect(targetA).toHaveBeenCalledTimes(1);

    current = targetB;
    rerender();
    act(() => {
      result.current.call();
    });
    expect(targetA).toHaveBeenCalledTimes(1);
    expect(targetB).toHaveBeenCalledTimes(1);
  });
});
