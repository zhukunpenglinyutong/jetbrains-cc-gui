import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReplyRecoveryPanel, { parseReplyRecoveryItems, type ReplyRecoveryItem } from './ReplyRecoveryPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const item: ReplyRecoveryItem = {
  eventId: '00000000-0000-4000-8000-000000000001', status: 'UNKNOWN', updatedAt: 1000,
  expiresAt: 2000, kind: 'FINAL_REPLY', reason: 'READY', retryStatus: '',
};

describe('reply-only recovery', () => {
  it('requires confirmation and cancellation never invokes retry', async () => {
    const onRetry = vi.fn();
    render(<ReplyRecoveryPanel items={[item]} available bindingRevision={1} currentBindingRevision={1}
      busy={false} onRefresh={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.retry' }));
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.cancel' }));
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.confirm' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledExactlyOnceWith(item.eventId, 1));
  });

  it('invalidates an open confirmation when binding changes', async () => {
    const onRetry = vi.fn();
    const props = { items: [item], available: true, bindingRevision: 1, busy: false, onRefresh: vi.fn(), onRetry };
    const { rerender } = render(<ReplyRecoveryPanel {...props} currentBindingRevision={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.retry' }));
    rerender(<ReplyRecoveryPanel {...props} currentBindingRevision={2} />);
    const confirmButton = screen.queryByRole('button', { name: 'settings.clawBot.recovery.confirm' });
    if (confirmButton) {
      expect(confirmButton.hasAttribute('disabled')).toBe(true);
      fireEvent.click(confirmButton);
    }
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'settings.clawBot.recovery.retry' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the recorded recovery outcome without offering a second recovery', () => {
    render(<ReplyRecoveryPanel items={[{ ...item, reason: 'RETRY_STARTED', retryStatus: 'UNKNOWN' }]}
      available bindingRevision={1} currentBindingRevision={1} busy={false} onRefresh={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'settings.clawBot.recovery.retry' })).toBeNull();
    expect(screen.getByText('settings.clawBot.recovery.reasons.RETRY_STARTED')).toBeTruthy();
  });

  it('rejects oversized, malformed and unsafe diagnostic payloads', () => {
    expect(parseReplyRecoveryItems(Array.from({ length: 9 }, () => item))).toBeNull();
    expect(parseReplyRecoveryItems([{ ...item, eventId: '<script>' }])).toBeNull();
    expect(parseReplyRecoveryItems([{ ...item, updatedAt: -1 }])).toBeNull();
    expect(parseReplyRecoveryItems([{ ...item, reason: 'APPROVE' }])).toBeNull();
    expect(parseReplyRecoveryItems([item])).toEqual([item]);
  });
});
