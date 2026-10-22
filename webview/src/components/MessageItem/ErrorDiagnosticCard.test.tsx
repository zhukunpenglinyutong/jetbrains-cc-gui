import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorDiagnosticCard } from './ErrorDiagnosticCard';
import { matchErrorPattern, type DiagnosticPattern } from '../../utils/errorMatcher';

const t = ((key: string, options?: Record<string, unknown>) =>
  (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction;

afterEach(() => {
  window.sendToJava = undefined;
});

describe('ErrorDiagnosticCard', () => {
  it('opens the official platform install instructions without running installation commands', () => {
    window.sendToJava = vi.fn();
    const pattern = matchErrorPattern('codex app-server exited (code=1, signal=null)\nCodex CLI check');
    expect(pattern).not.toBeNull();
    render(<ErrorDiagnosticCard t={t} pattern={pattern!} />);

    const link = screen.getByRole('link', { name: 'settings.cli.installDialog.openDocs' });
    expect(link.getAttribute('href')).toBe('https://learn.chatgpt.com/docs/codex/cli#getting-started');
    expect(screen.getByText('codex --version')).toBeTruthy();
    expect(screen.queryByText('npm uninstall -g @openai/codex')).toBeNull();
    fireEvent.click(link);

    expect(window.sendToJava).toHaveBeenCalledExactlyOnceWith(
      'open_browser_external:https://learn.chatgpt.com/docs/codex/cli#getting-started',
    );
  });

  it('preserves SDK command and dependency navigation steps', () => {
    const onNavigate = vi.fn();
    render(<ErrorDiagnosticCard t={t} onNavigateToDependencySettings={onNavigate} pattern={{
      code: 'fixture',
      solutions: [{ key: 'fixture', recommended: true, steps: [
        { kind: 'command', command: 'node -v' },
        { kind: 'navigation', action: 'openDependencySettings' },
      ] }],
    }} />);

    expect(screen.getByText('node -v')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'errorDiagnostic.openDependencySettings' }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});

const versionTooOld = matchErrorPattern(
  'Claude Code 2.1.39 does not support this model; version 2.1.280 or newer is required.',
) as DiagnosticPattern;

const respond = async (payload: unknown) => {
  await act(async () => {
    window.dependencyInstallResult?.(JSON.stringify(payload));
  });
};

describe('ErrorDiagnosticCard Claude SDK update action', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.dependencyInstallResult = undefined;
  });

  afterEach(async () => {
    await respond({ success: false, sdkId: 'claude-sdk' });
    window.dependencyInstallResult = undefined;
  });

  it('updates the SDK in place and shows the installed version', async () => {
    render(<ErrorDiagnosticCard t={t} pattern={versionTooOld} />);

    fireEvent.click(screen.getByRole('button', { name: 'errorDiagnostic.updateClaudeSdk' }));

    expect(window.sendToJava).toHaveBeenCalledWith('update_dependency:{"id":"claude-sdk"}');
    const updating = screen.getByRole('button', { name: 'errorDiagnostic.updatingClaudeSdk' }) as HTMLButtonElement;
    expect(updating.disabled).toBe(true);

    await respond({ success: true, sdkId: 'claude-sdk', installedVersion: '0.3.300' });

    expect(screen.getByRole('status').textContent)
      .toBe('errorDiagnostic.updateClaudeSdkSuccess {"version":"0.3.300"}');
    expect(screen.queryByRole('button', { name: 'errorDiagnostic.updateClaudeSdk' })).toBeNull();
  });

  it('shows the failure, keeps the button for a retry and links to the dependency settings', async () => {
    const onNavigate = vi.fn();
    render(<ErrorDiagnosticCard t={t} pattern={versionTooOld} onNavigateToDependencySettings={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: 'errorDiagnostic.updateClaudeSdk' }));
    await respond({ success: false, sdkId: 'claude-sdk', error: 'npm install failed with exit code: 1' });

    expect(screen.getByRole('alert').textContent)
      .toBe('errorDiagnostic.updateClaudeSdkFailed {"error":"npm install failed with exit code: 1"}');
    expect(screen.getByRole('button', { name: 'errorDiagnostic.updateClaudeSdk' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'errorDiagnostic.openDependencySettings' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
