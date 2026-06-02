import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useModelProviderState } from './useModelProviderState';

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

const t = ((key: string) => key) as never;
const addToast = vi.fn();

describe('useModelProviderState', () => {
  it('uses one SDK status state for callbacks and computed install status', () => {
    const { result } = renderHook(() => useModelProviderState({ addToast, t }));

    expect(result.current.sdkStatusLoaded).toBe(false);
    expect(result.current.currentSdkInstalled).toBe(false);

    act(() => {
      result.current.setSdkStatus({
        'claude-sdk': { status: 'installed' },
      });
      result.current.setSdkStatusLoaded(true);
    });

    expect(result.current.sdkStatusLoaded).toBe(true);
    expect(result.current.currentSdkInstalled).toBe(true);
  });
});
