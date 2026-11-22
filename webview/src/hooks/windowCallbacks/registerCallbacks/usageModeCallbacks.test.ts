/**
 * usageModeCallbacks.test.ts
 *
 * updateActiveProvider forwarding: registerUsageModeCallbacks replaces the
 * bootstrap dispatcher installed by runtimeProviderCapabilities with the App
 * handler. It must forward every push to that dispatcher so
 * subscribeActiveProvider subscribers (RuntimeProviderSelect,
 * useClaudePlanUsage, …) keep receiving events — replacing it silently would
 * cut off the whole subscriber registry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installRuntimeProviderDispatchers,
  subscribeActiveProvider,
} from '../../../utils/runtimeProviderCapabilities';
import { registerUsageModeCallbacks } from './usageModeCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

function createOptions() {
  const calls = {
    setActiveProviderConfig: vi.fn(),
    setProviderConfigVersion: vi.fn(),
    syncActiveProviderModelMapping: vi.fn(),
  };
  const noop = () => {};
  const options = {
    setUsagePercentage: noop,
    setUsageUsedTokens: noop,
    setUsageMaxTokens: noop,
    setPermissionMode: noop,
    setCurrentProvider: noop,
    setClaudePermissionMode: noop,
    setCodexPermissionMode: noop,
    setSelectedClaudeModel: noop,
    setSelectedCodexModel: noop,
    setLongContextEnabled: noop,
    setReasoningEffort: noop,
    setCodexFastMode: noop,
    setClaudeSettingsAlwaysThinkingEnabled: noop,
    setStreamingEnabledSetting: noop,
    setSendShortcut: noop,
    setAutoOpenFileEnabled: noop,
    setPermissionDialogTimeoutSeconds: noop,
    currentProviderRef: { current: 'claude' },
    setProviderConfigVersion: calls.setProviderConfigVersion,
    setActiveProviderConfig: calls.setActiveProviderConfig,
    syncActiveProviderModelMapping: calls.syncActiveProviderModelMapping,
  } as unknown as UseWindowCallbacksOptions;
  return { options, calls };
}

const w = window as unknown as Record<string, unknown>;

afterEach(() => {
  for (const key of [
    'onUsageUpdate', 'onModeChanged', 'onModeReceived', 'onModelChanged',
    'onModelConfirmed', 'updateActiveProvider', 'updateThinkingEnabled',
    'updateStreamingEnabled', 'updateSendShortcut', 'updateAutoOpenFileEnabled',
  ]) {
    delete w[key];
  }
});

describe('updateActiveProvider forwarding', () => {
  it('delivers pushes to both the App handler and subscribeActiveProvider subscribers', () => {
    // Bootstrap installs the dispatcher first; App registration then wraps it.
    installRuntimeProviderDispatchers();
    const subscriber = vi.fn();
    const unsubscribe = subscribeActiveProvider(subscriber);

    const { options, calls } = createOptions();
    registerUsageModeCallbacks(options);

    const payload = JSON.stringify({ id: 'deepseek-main', isActive: true });
    (window.updateActiveProvider as (json: string) => void)(payload);

    // The App handler ran…
    expect(calls.syncActiveProviderModelMapping).toHaveBeenCalledTimes(1);
    expect(calls.setActiveProviderConfig).toHaveBeenCalledTimes(1);
    expect(calls.setProviderConfigVersion).toHaveBeenCalledWith(expect.any(Function));
    // …and the bootstrap dispatcher's subscribers received the same push.
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenLastCalledWith(payload);

    unsubscribe();
  });
});
