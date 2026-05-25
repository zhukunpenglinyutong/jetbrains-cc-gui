import { act, renderHook } from '@testing-library/react';
import { useDialogManagement } from './useDialogManagement';

const t = ((key: string) => key) as any;

describe('useDialogManagement - context usage requestId isolation', () => {
  it('openContextUsageDialog sets requestId and opens dialog', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openContextUsageDialog('req-1', true);
    });

    expect(result.current.contextUsageDialogOpen).toBe(true);
    expect(result.current.contextUsageIsLoading).toBe(true);
    expect(result.current.contextUsageData).toBeNull();
  });

  it('updateContextUsageData accepts matching requestId', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    const data = { totalTokens: 1000, maxTokens: 200000 } as any;

    act(() => {
      result.current.openContextUsageDialog('req-1', true);
    });

    let accepted: boolean;
    act(() => {
      accepted = result.current.updateContextUsageData('req-1', data);
    });

    expect(accepted!).toBe(true);
    expect(result.current.contextUsageIsLoading).toBe(false);
    expect(result.current.contextUsageData).toBe(data);
  });

  it('updateContextUsageData rejects stale requestId', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    const data1 = { totalTokens: 1000 } as any;
    const data2 = { totalTokens: 2000 } as any;

    // Open with req-1
    act(() => {
      result.current.openContextUsageDialog('req-1', true);
    });

    // Open with req-2 (simulates a new request before the first completes)
    act(() => {
      result.current.openContextUsageDialog('req-2', true);
    });

    // Late response for req-1 should be rejected
    let accepted: boolean;
    act(() => {
      accepted = result.current.updateContextUsageData('req-1', data1);
    });
    expect(accepted!).toBe(false);
    expect(result.current.contextUsageData).toBeNull();

    // Response for req-2 should be accepted
    act(() => {
      accepted = result.current.updateContextUsageData('req-2', data2);
    });
    expect(accepted!).toBe(true);
    expect(result.current.contextUsageData).toBe(data2);
  });

  it('closeContextUsageDialog with no requestId closes current dialog', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openContextUsageDialog('req-1', true);
    });
    expect(result.current.contextUsageDialogOpen).toBe(true);

    // Close without requestId (user clicks X button)
    let closed: boolean;
    act(() => {
      closed = result.current.closeContextUsageDialog();
    });

    expect(closed!).toBe(true);
    expect(result.current.contextUsageDialogOpen).toBe(false);
    expect(result.current.contextUsageData).toBeNull();
  });

  it('closeContextUsageDialog rejects stale requestId', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openContextUsageDialog('req-1', true);
    });

    // Switch to req-2
    act(() => {
      result.current.openContextUsageDialog('req-2', true);
    });

    // Try to close with stale req-1
    let closed: boolean;
    act(() => {
      closed = result.current.closeContextUsageDialog('req-1');
    });

    expect(closed!).toBe(false);
    expect(result.current.contextUsageDialogOpen).toBe(true);

    // Close with correct req-2
    act(() => {
      closed = result.current.closeContextUsageDialog('req-2');
    });
    expect(closed!).toBe(true);
    expect(result.current.contextUsageDialogOpen).toBe(false);
  });

  it('closeContextUsageDialog with null requestId closes (force close)', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => {
      result.current.openContextUsageDialog('req-1', true);
    });

    // null requestId means "close whatever is open"
    let closed: boolean;
    act(() => {
      closed = result.current.closeContextUsageDialog(null);
    });

    expect(closed!).toBe(true);
    expect(result.current.contextUsageDialogOpen).toBe(false);
  });
});
