import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendBridgeEvent } from '../../utils/bridge';
import { useOmpProvider } from './useOmpProvider';

vi.mock('../../utils/bridge', () => ({ sendBridgeEvent: vi.fn(() => true) }));

describe('useOmpProvider approval mode', () => {
  beforeEach(() => vi.mocked(sendBridgeEvent).mockClear());

  afterEach(() => {
    delete window.onOmpApprovalModeReceived;
    delete window.__pendingOmpApprovalMode;
  });

  it('reports a change of the picker to Java, which keeps the tab\'s choice', () => {
    const { result } = renderHook(() => useOmpProvider());

    act(() => result.current.handleOmpApprovalModeChange('always-ask'));

    expect(result.current.ompApprovalMode).toBe('always-ask');
    expect(sendBridgeEvent).toHaveBeenCalledExactlyOnceWith('set_omp_approval_mode', 'always-ask');
  });

  // After a page reload the hook starts at "default" again, which means OMP's
  // own setting (usually full auto). Java puts the tab's choice back.
  it('takes the tab\'s choice back from Java without echoing it', () => {
    const { result } = renderHook(() => useOmpProvider());
    expect(result.current.ompApprovalMode).toBe('default');

    act(() => window.onOmpApprovalModeReceived?.('always-ask'));

    expect(result.current.ompApprovalMode).toBe('always-ask');
    expect(sendBridgeEvent).not.toHaveBeenCalled();
  });

  it('applies a choice Java sent before the hook mounted', () => {
    window.__pendingOmpApprovalMode = 'write';

    const { result } = renderHook(() => useOmpProvider());

    expect(result.current.ompApprovalMode).toBe('write');
    expect(window.__pendingOmpApprovalMode).toBeUndefined();
  });

  it('falls back to default for a mode it does not know', () => {
    const { result } = renderHook(() => useOmpProvider());
    act(() => result.current.handleOmpApprovalModeChange('yolo'));

    act(() => window.onOmpApprovalModeReceived?.('always-ask-cached'));

    expect(result.current.ompApprovalMode).toBe('default');
  });
});
