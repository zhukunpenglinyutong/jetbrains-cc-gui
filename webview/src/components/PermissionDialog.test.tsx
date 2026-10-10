import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PermissionDialog, { type PermissionRequest } from './PermissionDialog';
import { resetLinkifyCapabilities, setLinkifyCapabilities } from '../utils/linkifyCapabilities';

vi.mock('../hooks/useDialogResize', () => ({
  useDialogResize: () => ({
    dialogRef: { current: null },
    dialogHeight: null,
    setDialogHeight: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: unknown) => {
      if (typeof fallbackOrOptions === 'string') {
        return fallbackOrOptions;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('PermissionDialog', () => {
  const buildRequest = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
    channelId: 'perm-1',
    toolName: 'bash',
    inputs: {
      cwd: 'src/components',
      command: 'echo hello',
    },
    ...overrides,
  });

  beforeEach(() => {
    resetLinkifyCapabilities();
    setLinkifyCapabilities({ classNavigationEnabled: true });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reuses MarkdownBlock linkify inside the command content area', () => {
    const request: PermissionRequest = {
      channelId: 'perm-1',
      toolName: 'bash',
      inputs: {
        cwd: 'src/components',
        command: [
          'Read src/components/App.tsx',
          '',
          'Inspect com.github.claudecodegui.handler.file.OpenFileHandler',
          '',
          'Reference https://example.com/docs',
        ].join('\n'),
      },
    };

    render(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'src/components/App.tsx' })).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'com.github.claudecodegui.handler.file.OpenFileHandler',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();
  });

  it('reopens the submission guard after a refused bridge send and accepts a retry', () => {
    const onApprove = vi.fn(() => false as boolean | void);
    render(<PermissionDialog isOpen request={buildRequest({ provider: 'codex' })}
      onApprove={onApprove} onSkip={() => {}} onApproveAlways={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'permission.allow 1' }));
    onApprove.mockReturnValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'permission.allow 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'permission.allow 1' }));
    expect(onApprove).toHaveBeenCalledTimes(2);
  });

  it('formats non-string command payloads before rendering markdown', () => {
    const request: PermissionRequest = {
      channelId: 'perm-2',
      toolName: 'bash',
      inputs: {
        cwd: 'src/components',
        command: [
          { text: 'Read src/components/App.tsx' },
          { content: 'Reference https://example.com/docs' },
          7,
        ],
      },
    };

    render(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'src/components/App.tsx' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();
    expect(document.querySelector('.permission-dialog-v3-command-content')?.textContent).toContain('7');
  });

  it('only renders native decisions advertised by the server', () => {
    render(
      <PermissionDialog
        isOpen
        request={buildRequest({
          provider: 'codex',
          codexMethod: 'item/commandExecution/requestApproval',
          suggestions: ['decline', 'cancel'],
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: 'permission.allow 1' })).toBeNull();
    expect(screen.getByRole('button', { name: /permission.deny/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
  });

  it('blocks approval when a native file change has no preview', () => {
    render(
      <PermissionDialog
        isOpen
        request={buildRequest({
          provider: 'codex',
          codexMethod: 'item/fileChange/requestApproval',
          suggestions: ['accept', 'decline', 'cancel'],
          inputs: { cwd: 'src', reason: 'edit' },
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByTestId('codex-file-preview').textContent).toContain('preview');
    expect(screen.queryByRole('button', { name: /permission.allow/ })).toBeNull();
  });

  it('lists all native proposed file changes before approval', () => {
    render(
      <PermissionDialog
        isOpen
        request={buildRequest({
          provider: 'codex',
          codexMethod: 'item/fileChange/requestApproval',
          inputs: {
            changes: {
              'src/new.ts': { kind: 'add' },
              'src/old.ts': { kind: { type: 'update', movePath: 'src/renamed.ts' } },
            },
          },
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    expect(screen.getByTestId('codex-file-preview').textContent).toContain('src/new.ts');
    expect(screen.getByTestId('codex-file-preview').textContent).toContain('src/old.ts');
    expect(screen.getByTestId('codex-file-preview').textContent).toContain('src/renamed.ts');
    expect(screen.getByTestId('codex-file-preview').textContent).not.toContain('[object Object]');
  });

  it('shows the native additional permission subset before granting it', () => {
    render(
      <PermissionDialog
        isOpen
        request={buildRequest({
          provider: 'codex',
          codexMethod: 'item/permissions/requestApproval',
          inputs: {
            permissions: {
              filesystem: { roots: ['C:/repo'], access: ['read'] },
              network: { hosts: ['example.com'] },
            },
          },
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    expect(screen.getByTestId('codex-permission-scope').textContent).toContain('example.com');
    expect(screen.getByTestId('codex-permission-scope').textContent).toContain('C:/repo');
  });

  it('exposes native command rule amendments as typed decisions', () => {
    const onDecision = vi.fn();
    render(
      <PermissionDialog
        isOpen
        request={buildRequest({
          provider: 'codex',
          codexMethod: 'item/commandExecution/requestApproval',
          suggestions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['allow echo'] } }],
        })}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
        onDecision={onDecision}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Allow with this command rule/ }));
    expect(onDecision).toHaveBeenCalledWith('perm-1', {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ['allow echo'] },
    });
  });

  it('auto-denies with the original channelId after timeoutSeconds elapses', () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={30}
      />,
    );

    expect(onSkip).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledWith('perm-1');
    expect(onApprove).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  it('manual approval suppresses the later auto-deny', () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={30}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'permission.allow 1' }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('perm-1');
    expect(onSkip).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  it('keeps the duplicate-response guard when timeoutSeconds changes after approval', () => {
    vi.useFakeTimers();
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();
    const request = buildRequest();

    const { rerender } = render(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={30}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'permission.allow 1' }));

    rerender(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
        timeoutSeconds={60}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('perm-1');
    expect(onSkip).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  // The dialog overlay sits above the chat input but the keydown listener is on
  // window, so without the editable-target guard a stray Enter in any input
  // (chat box, settings, etc.) would silently auto-approve the pending tool call.
  it('ignores Enter when focus is on an INPUT element', () => {
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } finally {
      input.remove();
    }

    expect(onApprove).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
  });

  it('ignores option-shortcut digits (1/2/3) when focus is on an INPUT element', () => {
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      for (const key of ['1', '2', '3']) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
    } finally {
      input.remove();
    }

    expect(onApprove).not.toHaveBeenCalled();
    expect(onApproveAlways).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('still honors Enter when no editable element has focus', () => {
    const onApprove = vi.fn();
    const onSkip = vi.fn();
    const onApproveAlways = vi.fn();

    render(
      <PermissionDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onSkip={onSkip}
        onApproveAlways={onApproveAlways}
      />,
    );

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('perm-1');
  });
});
