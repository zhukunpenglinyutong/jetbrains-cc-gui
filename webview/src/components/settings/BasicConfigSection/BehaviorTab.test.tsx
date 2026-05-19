import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import BehaviorTab from './BehaviorTab';
import {
  MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS,
} from '../../../utils/permissionDialogTimeout';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function renderBehaviorTab(overrides: Partial<ComponentProps<typeof BehaviorTab>> = {}) {
  const props = {
    streamingEnabled: true,
    onStreamingEnabledChange: vi.fn(),
    codexSandboxMode: 'workspace-write',
    onCodexSandboxModeChange: vi.fn(),
    sendShortcut: 'enter' as const,
    onSendShortcutChange: vi.fn(),
    autoOpenFileEnabled: false,
    onAutoOpenFileEnabledChange: vi.fn(),
    commitGenerationEnabled: true,
    onCommitGenerationEnabledChange: vi.fn(),
    aiTitleGenerationEnabled: true,
    onAiTitleGenerationEnabledChange: vi.fn(),
    taskCompletionNotificationEnabled: false,
    onTaskCompletionNotificationEnabledChange: vi.fn(),
    permissionDialogTimeoutSeconds: 300,
    onPermissionDialogTimeoutChange: vi.fn(),
    ...overrides,
  };

  render(<BehaviorTab {...props} />);
  return props;
}

describe('BehaviorTab permission dialog timeout', () => {
  it('exposes the timeout number input with an accessible label', () => {
    renderBehaviorTab();

    expect(
      screen.getByRole('spinbutton', { name: /settings.basic.permissionDialogTimeout.label/i }),
    ).toBeTruthy();
  });

  it('exposes native HTML5 min/max attributes that mirror the clamp constants', () => {
    // The native min/max attributes give browsers a chance to flag out-of-range values
    // before our onBlur/Enter clamp runs. They MUST stay in lockstep with the JS clamp,
    // otherwise the browser hint disagrees with what we accept on submission.
    renderBehaviorTab();

    const input = screen.getByRole('spinbutton', {
      name: /settings.basic.permissionDialogTimeout.label/i,
    });

    expect(input.getAttribute('min')).toBe(String(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS));
    expect(input.getAttribute('max')).toBe(String(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS));
  });

  it('clamps low values on blur', () => {
    const onPermissionDialogTimeoutChange = vi.fn();
    renderBehaviorTab({ onPermissionDialogTimeoutChange });

    const input = screen.getByRole('spinbutton', { name: /settings.basic.permissionDialogTimeout.label/i });
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);

    expect(onPermissionDialogTimeoutChange).toHaveBeenCalledWith(30);
  });

  it('clamps high values on Enter', () => {
    const onPermissionDialogTimeoutChange = vi.fn();
    renderBehaviorTab({ onPermissionDialogTimeoutChange });

    const input = screen.getByRole('spinbutton', { name: /settings.basic.permissionDialogTimeout.label/i });
    fireEvent.change(input, { target: { value: '99999' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onPermissionDialogTimeoutChange).toHaveBeenCalledWith(3600);
  });
});
