import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorDiagnosticCard } from './ErrorDiagnosticCard';
import { matchErrorPattern } from '../../utils/errorMatcher';

const t = ((key: string) => key) as TFunction;

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
