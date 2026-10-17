import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PermissionsSection from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: unknown) => {
    if (typeof options === 'object' && options && 'defaultValue' in options) {
      const value = (options as { defaultValue: string }).defaultValue;
      return value
        .replace('{{source}}', String((options as { source?: unknown }).source ?? ''))
        .replace('{{mode}}', String((options as { mode?: unknown }).mode ?? ''));
    }
    return _key;
  } }),
}));

describe('PermissionsSection', () => {
  it('renders the native read-only range and preserves source metadata', () => {
    const onChange = vi.fn();
    render(
      <PermissionsSection
        codexSandboxMode="read-only"
        codexSandboxSource="user"
        onCodexSandboxModeChange={onChange}
      />,
    );
    expect((screen.getByDisplayValue('read-only') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Source: user')).toBeTruthy();
    expect(screen.getByText('Desired: read-only · Effective: read-only')).toBeTruthy();
    fireEvent.click(screen.getByDisplayValue('danger-full-access'));
    expect(onChange).toHaveBeenCalledWith('danger-full-access');
  });

  it('surfaces a native desired/effective conflict without changing the selected range', () => {
    render(
      <PermissionsSection
        codexSandboxMode="workspace-write"
        codexSandboxSource="native"
        codexSandboxDesired="danger-full-access"
        codexSandboxEffective="workspace-write"
        codexSandboxConflict
        onCodexSandboxModeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Source: native')).toBeTruthy();
    expect(screen.getByText('Desired: danger-full-access · Effective: workspace-write')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect((screen.getByDisplayValue('workspace-write') as HTMLInputElement).checked).toBe(true);
  });
});

