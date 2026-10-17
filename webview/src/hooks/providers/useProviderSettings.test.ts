import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { useProviderSettings } from './useProviderSettings';
import { readClaudeModelMapping } from '../../utils/claudeModelMapping';
import { useProviderManagement } from '../../components/settings/hooks/useProviderManagement';

vi.mock('../../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('provider model mapping synchronization', () => {
  beforeEach(() => localStorage.clear());
  it('syncs names and ids separately when changing providers and clears them on deactivation', () => {
    const { result } = renderHook(() => useProviderSettings({ addToast: vi.fn(), t: ((key: string) => key) as TFunction }));
    act(() => result.current.syncActiveProviderModelMapping({
      id: 'provider-a', name: 'Provider A', settingsConfig: { env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Flash',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Pro',
      } },
    }));
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'claude-sonnet-5', sonnetName: 'Flash', fable: 'claude-fable-5', fableName: 'Pro' });
    act(() => result.current.syncActiveProviderModelMapping({
      id: 'provider-b', name: 'Provider B', settingsConfig: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'direct-flash' } },
    }));
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'direct-flash' });
    act(() => result.current.syncActiveProviderModelMapping(null));
    expect(readClaudeModelMapping()).toEqual({});
  });

  it('preserves display names when refreshing the provider list in settings', () => {
    const { result } = renderHook(() => useProviderManagement());
    act(() => result.current.updateProviders([{
      id: 'provider-a', name: 'Provider A', isActive: true,
      settingsConfig: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Flash' } },
    }]));
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'claude-sonnet-5', sonnetName: 'Flash' });
    act(() => result.current.updateProviders([]));
    expect(readClaudeModelMapping()).toEqual({});
  });
});
