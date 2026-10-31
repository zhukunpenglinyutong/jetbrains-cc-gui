import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CodexProviderConfig } from '../../types/provider';
import { useCodexProviderForm } from './useCodexProviderForm';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('useCodexProviderForm environment names', () => {
  it('saves normalized message and MCP keys while preserving values and input data', () => {
    const provider: CodexProviderConfig = {
      id: 'test', name: 'Synthetic', configToml: '', authJson: '{}',
      messageEnvVars: [{ key: ' HTTPS_PROXY ', value: '  unchanged  ' }],
      mcpEnvVars: [{ key: '\u00a0API_TOKEN\ufeff', value: '  synthetic  ' }, { key: ' ', value: '' }],
    };
    const onSave = vi.fn();
    const addToast = vi.fn();
    const { result } = renderHook(() => useCodexProviderForm({
      isOpen: true, provider, onSave, onClose: vi.fn(), addToast,
    }));
    act(() => result.current.handleSave());
    expect(addToast).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      messageEnvVars: [{ key: 'HTTPS_PROXY', value: '  unchanged  ' }],
      mcpEnvVars: [{ key: 'API_TOKEN', value: '  synthetic  ' }],
    }));
    expect(provider.messageEnvVars?.[0].key).toBe(' HTTPS_PROXY ');
  });

  it('does not save colliding normalized keys', () => {
    const provider: CodexProviderConfig = {
      id: 'test', name: 'Synthetic', authJson: '{}',
      messageEnvVars: [{ key: ' A ', value: '1' }, { key: 'a', value: '2' }],
    };
    const onSave = vi.fn();
    const addToast = vi.fn();
    const { result } = renderHook(() => useCodexProviderForm({
      isOpen: true, provider, onSave, onClose: vi.fn(), addToast,
    }));
    act(() => result.current.handleSave());
    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('envKeyDuplicate'), 'error');
  });
});
