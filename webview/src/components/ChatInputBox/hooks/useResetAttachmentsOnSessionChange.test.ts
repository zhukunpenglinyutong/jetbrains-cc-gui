import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { forceWebviewRepaint } from '../../../utils/forceWebviewRepaint.js';
import { useResetAttachmentsOnSessionChange } from './useResetAttachmentsOnSessionChange.js';

vi.mock('../../../utils/forceWebviewRepaint.js', () => ({ forceWebviewRepaint: vi.fn() }));

describe('useResetAttachmentsOnSessionChange', () => {
  beforeEach(() => {
    vi.mocked(forceWebviewRepaint).mockClear();
  });

  it('does not clear or repaint on the initial mount', () => {
    const clear = vi.fn();
    renderHook(() =>
      useResetAttachmentsOnSessionChange({
        currentSessionId: 'a',
        isControlled: false,
        clearInternalAttachments: clear,
      })
    );

    expect(clear).not.toHaveBeenCalled();
    expect(forceWebviewRepaint).not.toHaveBeenCalled();
  });

  it('clears attachments and repaints when the session id changes (uncontrolled)', () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useResetAttachmentsOnSessionChange({
          currentSessionId: id,
          isControlled: false,
          clearInternalAttachments: clear,
        }),
      { initialProps: { id: 'a' as string | null } }
    );

    rerender({ id: 'b' });

    expect(clear).toHaveBeenCalledTimes(1);
    expect(forceWebviewRepaint).toHaveBeenCalledTimes(1);
  });

  it('repaints but does NOT clear in controlled mode', () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useResetAttachmentsOnSessionChange({
          currentSessionId: id,
          isControlled: true,
          clearInternalAttachments: clear,
        }),
      { initialProps: { id: 'a' as string | null } }
    );

    rerender({ id: 'b' });

    expect(clear).not.toHaveBeenCalled();
    expect(forceWebviewRepaint).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the session id is unchanged across rerenders', () => {
    const clear = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useResetAttachmentsOnSessionChange({
          currentSessionId: id,
          isControlled: false,
          clearInternalAttachments: clear,
        }),
      { initialProps: { id: 'a' as string | null } }
    );

    rerender({ id: 'a' });

    expect(clear).not.toHaveBeenCalled();
    expect(forceWebviewRepaint).not.toHaveBeenCalled();
  });
});
