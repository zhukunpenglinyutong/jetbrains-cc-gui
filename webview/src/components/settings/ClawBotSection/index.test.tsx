import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClawBotSection from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('ClawBotSection', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.onClawBotStatus = undefined;
    window.onClawBotOperation = undefined;
  });

  it('loads recovery through explicit controls and resends only after confirmation', () => {
    render(<ClawBotSection />);
    act(() => {
      window.onClawBotStatus?.('{"state":"LEADER","transport":"ILINK","sessionCount":1,"bindingState":"BOUND","bindingRevision":1}');
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.load' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith('clawbot_list_reply_recovery:{}');
    act(() => {
      window.onClawBotOperation?.(JSON.stringify({ operation: 'list_reply_recovery', ok: true,
        replyRecoveryAvailable: true, replyRecoveryBindingRevision: 1,
        replyRecoveryItems: [{ eventId: '00000000-0000-4000-8000-000000000001', status: 'UNKNOWN',
          updatedAt: 1000, expiresAt: 2000, kind: 'FINAL_REPLY', reason: 'READY', retryStatus: '' }],
      }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.retry' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith('clawbot_list_reply_recovery:{}');
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.recovery.confirm' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith(
      'clawbot_retry_reply:{"eventId":"00000000-0000-4000-8000-000000000001","bindingRevision":1,"confirmed":true}',
    );
  });

  it('requests and renders sanitized gateway status', () => {
    render(<ClawBotSection />);

    expect(window.sendToJava).toHaveBeenCalledWith('get_clawbot_status:');
    act(() => {
      window.onClawBotStatus?.('{"state":"LEADER","transport":"MOCK","sessionCount":2,"bindingState":"UNBOUND","bindingRevision":0}');
    });
    expect(screen.getByText('settings.clawBot.states.leader')).toBeTruthy();
    const statusToggle = screen.getByRole('button', {
      name: 'settings.clawBot.expandGatewayDetails',
    });
    expect(statusToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(statusToggle);
    expect(statusToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('settings.clawBot.bindingStates.unbound')).toBeTruthy();
    const bindingRevisionRow = screen.getByText('settings.clawBot.bindingRevision').parentElement;
    const pairingRefreshRow = screen.getByText('settings.clawBot.pairingRefreshCount').parentElement;
    expect(bindingRevisionRow).not.toBeNull();
    expect(pairingRefreshRow).not.toBeNull();
    expect(within(bindingRevisionRow as HTMLElement).getByText('0')).toBeTruthy();
    expect(within(pairingRefreshRow as HTMLElement).getByText('0')).toBeTruthy();
  });

  it('edits and saves progress intervals, then reflects the live gateway values', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'MOCK', sessionCount: 0,
        bindingState: 'UNBOUND', bindingRevision: 0,
        progressTextIntervalMinutes: 1,
        progressIdleReminderMinutes: 5,
        progressWaitReminderMinutes: 10,
      }));
    });

    const progressToggle = screen.getByRole('button', { name: 'settings.clawBot.expandProgressSettings' });
    expect(progressToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(progressToggle);
    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressTextInterval',
    }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressIdleReminderInterval',
    }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressWaitReminderInterval',
    }), { target: { value: '12' } });
    fireEvent.click(screen.getByText('settings.clawBot.advancedProgress'));
    expect(screen.getByText('settings.clawBot.advancedProgressDescription')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressInitialCheckDelay',
    }), { target: { value: '20' } });
    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressMaxNotifications',
    }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressExcerptMaxCharacters',
    }), { target: { value: '2000' } });
    fireEvent.change(screen.getByRole('spinbutton', {
      name: 'settings.clawBot.sessionIdleTimeout',
    }), { target: { value: '45' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.clawBot.saveProgressSettings' })[0]!);

    expect(window.sendToJava).toHaveBeenLastCalledWith(
      'clawbot_update_progress_settings:{"textIntervalMinutes":2,"idleReminderMinutes":6,"waitReminderMinutes":12,"initialCheckDelaySeconds":20,"maxNotifications":6,"minSendIntervalSeconds":120,"excerptMaxCharacters":2000,"sessionIdleTimeoutMinutes":45}',
    );
    act(() => {
      window.onClawBotOperation?.('{"operation":"update_progress_settings","ok":true}');
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'MOCK', sessionCount: 0,
        bindingState: 'UNBOUND', bindingRevision: 0,
        progressTextIntervalMinutes: 2,
        progressIdleReminderMinutes: 6,
        progressWaitReminderMinutes: 12,
        progressInitialCheckDelaySeconds: 20,
        progressMaxNotifications: 6,
        progressExcerptMaxCharacters: 2000,
        sessionIdleTimeoutMinutes: 45,
      }));
    });

    expect((screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressTextInterval',
    }) as HTMLInputElement).value).toBe('2');
    expect((screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressIdleReminderInterval',
    }) as HTMLInputElement).value).toBe('6');
    expect((screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressWaitReminderInterval',
    }) as HTMLInputElement).value).toBe('12');
    expect((screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressInitialCheckDelay',
    }) as HTMLInputElement).value).toBe('20');
    expect((screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressMaxNotifications',
    }) as HTMLInputElement).value).toBe('6');
    expect((screen.getByRole('spinbutton', {
      name: 'settings.clawBot.progressExcerptMaxCharacters',
    }) as HTMLInputElement).value).toBe('2000');
    expect((screen.getByRole('spinbutton', {
      name: 'settings.clawBot.sessionIdleTimeout',
    }) as HTMLInputElement).value).toBe('45');
  });

  it('renders outbound receipt counts without requiring recipient details', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER',
        transport: 'ILINK',
        transportState: 'READY',
        sessionCount: 1,
        senderAccessCount: 0,
        bindingState: 'BOUND',
        bindingRevision: 1,
        outboundReceiptStoreAvailable: true,
        outboundPendingCount: 1,
        outboundSentCount: 4,
        outboundUnknownCount: 2,
        outboundFailedCount: 1,
        outboundLatestStatus: 'UNKNOWN',
        outboundLatestError: 'ILINK_SEND_RESULT_UNKNOWN',
      }));
    });

    expect(screen.getByText('settings.clawBot.outboundReceipts').parentElement?.textContent)
      .toContain('4 / 2 / 1');
    expect(screen.getByText('settings.clawBot.outboundPending').parentElement?.textContent)
      .toContain('1');
    expect(screen.getByText('settings.clawBot.errors.ILINK_SEND_RESULT_UNKNOWN (ILINK_SEND_RESULT_UNKNOWN)')).toBeTruthy();
  });

  it('renders unknown IDE execution diagnostics without exposing message content', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'ILINK', transportState: 'READY', sessionCount: 1,
        senderAccessCount: 1, bindingState: 'BOUND', bindingRevision: 1,
        executionJournalAvailable: true, executionUnknownCount: 2,
      }));
    });

    expect(screen.getByText('settings.clawBot.executionUnknown').parentElement?.textContent)
      .toContain('2');
    expect(screen.queryByText(/message body|secret context/i)).toBeNull();
  });

  it('shows fail-closed behavior when the IDE execution journal is unavailable', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'ILINK', transportState: 'READY', sessionCount: 1,
        senderAccessCount: 1, bindingState: 'BOUND', bindingRevision: 1,
        executionJournalAvailable: false,
      }));
    });

    expect(screen.getByText('settings.clawBot.executionJournalUnavailable')).toBeTruthy();
  });

  it('renders poll retry delay and last successful transport activity', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'ILINK', transportState: 'READY', sessionCount: 1,
        senderAccessCount: 0, bindingState: 'BOUND', bindingRevision: 1,
        inboundLastSuccessAt: new Date(2026, 9, 3, 18, 46, 22).getTime(), inboundPollBackoffMillis: 30000,
        outboundLastSuccessAt: new Date(2026, 9, 4, 0, 4, 8).getTime(),
      }));
    });

    expect(screen.getByText('settings.clawBot.inboundRetryDelay').parentElement?.textContent)
      .toContain('30 s');
    expect(screen.getByText('settings.clawBot.inboundLastSuccess').parentElement?.textContent)
      .toContain('18:46:22');
    expect(screen.getByText('settings.clawBot.outboundLastSuccess').parentElement?.textContent)
      .toContain('00:04:08');
  });

  it('shows when the gateway has scheduled transport recovery', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'ILINK', transportState: 'STOPPED',
        transportRecoveryScheduled: true, sessionCount: 1,
        bindingState: 'BOUND', bindingRevision: 2,
      }));
    });

    expect(screen.getByText('settings.clawBot.transportRecovery').parentElement?.textContent)
      .toContain('settings.clawBot.transportRecoveryScheduled');
  });

  it('formats inbound errors and operation failures with their original codes', () => {
    render(<ClawBotSection />);
    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'MOCK', sessionCount: 2, bindingState: 'UNBOUND', bindingRevision: 12,
        inboundLastError: 'ILINK_AUTH_REJECTED (errcode=-14)',
      }));
      window.onClawBotOperation?.(JSON.stringify({ ok: false, errorCode: 'CLAWBOT_ILINK_REQUEST_TIMEOUT' }));
    });
    expect(screen.getByText('settings.clawBot.inboundLastError').parentElement?.textContent)
      .toContain('settings.clawBot.errors.ILINK_AUTH_REJECTED (ILINK_AUTH_REJECTED; errcode=-14)');
    expect(screen.getByRole('alert').textContent)
      .toBe('settings.clawBot.errors.CLAWBOT_ILINK_REQUEST_TIMEOUT (CLAWBOT_ILINK_REQUEST_TIMEOUT)');
  });

  it('ignores malformed or unsupported status payloads', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.('{"state":"LEADER","transport":"REAL","sessionCount":2,"bindingState":"UNBOUND","bindingRevision":0}');
    });

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('settings.clawBot.states.unknown')).toBeTruthy();
  });

  it('renders an unknown binding state from the Java fallback payload', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.('{"state":"STOPPED","transport":"MOCK","sessionCount":0,"bindingState":"UNKNOWN","bindingRevision":0}');
    });

    expect(screen.getByText('settings.clawBot.bindingStates.unknown')).toBeTruthy();
  });

  it('allows a new pairing attempt after a terminal pairing state', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER',
        transport: 'ILINK',
        transportState: 'STOPPED',
        sessionCount: 0,
        bindingState: 'UNBOUND',
        bindingRevision: 2,
        pairingState: 'EXPIRED',
        pairingAttempt: 0,
        pairing: { state: 'EXPIRED', refreshCount: 3, expiresAt: null },
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.bind' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith('clawbot_start_pairing:{}');
  });

  it('offers explicit cleanup without treating a ready transport as a confirmed binding', () => {
    render(<ClawBotSection />);
    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'ILINK', transportState: 'READY',
        sessionCount: 2, bindingState: 'UNKNOWN', bindingRevision: 11,
      }));
    });

    expect(screen.getByText('settings.clawBot.bindingStates.unknown')).toBeTruthy();
    expect(screen.getByText('settings.clawBot.bindingUnknownNotice')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.clawBot.bind' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.clawBot.allowSender' })).toBeNull();
    expect(window.sendToJava).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.unbind' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith('clawbot_unbind:{}');
  });

  it('shows a sanitized binding diagnostic code for an unknown state', () => {
    render(<ClawBotSection />);
    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER',
        transport: 'ILINK',
        transportState: 'READY',
        sessionCount: 1,
        bindingState: 'UNKNOWN',
        bindingRevision: 4,
        bindingDiagnostic: 'PASSWORD_SAFE_UNAVAILABLE',
      }));
    });

    const diagnosticNotice = screen.getAllByRole('note').find((element) =>
      element.textContent?.includes('PASSWORD_SAFE_UNAVAILABLE'));
    expect(diagnosticNotice?.textContent).toContain(
      'settings.clawBot.bindingDiagnostics.PASSWORD_SAFE_UNAVAILABLE',
    );
    expect(diagnosticNotice?.textContent).toContain('(PASSWORD_SAFE_UNAVAILABLE)');
  });

  it('keeps gateway status visible when a newer version sends an unknown binding diagnostic', () => {
    render(<ClawBotSection />);
    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER',
        transport: 'ILINK',
        transportState: 'READY',
        sessionCount: 1,
        bindingState: 'UNKNOWN',
        bindingRevision: 4,
        bindingDiagnostic: 'FUTURE_DIAGNOSTIC',
      }));
    });

    expect(screen.getByText('settings.clawBot.ready')).toBeTruthy();
    const diagnosticNotice = screen.getAllByRole('note').find((element) =>
      element.textContent?.includes('BINDING_STATUS_UNAVAILABLE'));
    expect(diagnosticNotice).toBeTruthy();
  });

  it('allows authorizing a sender without a duplicate manual revocation button', () => {
    render(<ClawBotSection />);

    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER',
        transport: 'ILINK',
        transportState: 'READY',
        sessionCount: 1,
        senderAccessCount: 2,
        bindingState: 'BOUND',
        bindingRevision: 3,
      }));
    });

    expect(screen.getByText('settings.clawBot.senderAccessCount').parentElement?.textContent).toContain('2');
    const senderInput = screen.getByRole('textbox', { name: 'settings.clawBot.senderId' });
    fireEvent.change(senderInput, { target: { value: 'wx-sender-1' } });

    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.allowSender' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith(
      'clawbot_allow_sender:{"senderId":"wx-sender-1"}',
    );
    act(() => {
      window.onClawBotOperation?.('{"operation":"allow_sender","ok":true}');
    });
    expect((senderInput as HTMLInputElement).value).toBe('');
    expect(window.sendToJava).toHaveBeenLastCalledWith('clawbot_list_senders:{"offset":0}');
    act(() => {
      window.onClawBotOperation?.('{"operation":"list_senders","ok":true,"authorizedSenders":[],"senderOffset":0,"senderHasMore":false,"senderTotalCount":0}');
    });
    expect(screen.queryByRole('button', { name: 'settings.clawBot.revokeSender' })).toBeNull();
  });

  it('loads paged authorized senders, renders redacted IDs, and supports per-sender revocation', () => {
    render(<ClawBotSection />);
    act(() => {
      window.onClawBotStatus?.(JSON.stringify({
        state: 'LEADER', transport: 'ILINK', transportState: 'READY', sessionCount: 1,
        senderAccessCount: 9, bindingState: 'BOUND', bindingRevision: 3,
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.manageSenders' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith('clawbot_list_senders:{"offset":0}');
    act(() => {
      window.onClawBotOperation?.(JSON.stringify({
        operation: 'list_senders', ok: true, authorizedSenders: ['wx-sender-123456'],
        senderOffset: 0, senderHasMore: true, senderTotalCount: 9,
        senderLastUsedAt: { 'wx-sender-123456': 1760000000000 },
      }));
    });
    expect(screen.getByText('wx-sen...56')).toBeTruthy();
    expect(screen.getByText(/settings\.clawBot\.senderLastUsed/).parentElement?.textContent)
      .not.toContain('settings.clawBot.never');
    expect(screen.queryByText('wx-sender-123456')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.nextSenders' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith('clawbot_list_senders:{"offset":8}');

    act(() => {
      window.onClawBotOperation?.(JSON.stringify({
        operation: 'list_senders', ok: true, authorizedSenders: ['wx-sender-123456'],
        senderOffset: 0, senderHasMore: true, senderTotalCount: 9,
      }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.clawBot.revokeListedSender' }));
    expect(window.sendToJava).toHaveBeenLastCalledWith(
      'clawbot_revoke_sender:{"senderId":"wx-sender-123456"}',
    );
  });
});
