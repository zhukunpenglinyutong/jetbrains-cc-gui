import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useReasoningEffortGuard } from '../../components/ChatInputBox/reasoningUtils';
import type { ReasoningEffort } from '../../components/ChatInputBox/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCliModelsCacheForTests, useCliModels, useOmpRoles } from './useCliModels';
import { CODEX_MODELS, KIMI_MODELS, OMP_ROLE_MODELS, apply1MContextSuffix, modelSupports1MContext } from '../../components/ChatInputBox/types';
import { installRuntimeProviderDispatchers } from '../../utils/runtimeProviderCapabilities';
import { readClaudeModelMapping, writeClaudeModelMapping } from '../../utils/claudeModelMapping';
import { setSessionClaudeModelCatalog } from '../../utils/sessionClaudeModelCatalog';
import { codexModelReasoningEfforts, getCodexReasoningCapabilities, isCodexUltraCapabilityUnconfirmed,
  subscribeCodexReasoningCapabilities } from '../../utils/codexReasoningCapabilities';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function emitCliModels(payload: unknown) {
  act(() => {
    window.setCliModels?.(JSON.stringify(payload));
  });
}

describe('useCliModels', () => {
  it('preserves a saved Ultra preference across discovery timeout and retries before deciding support', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => {
      const catalog = useCliModels('codex');
      const [effort, setEffort] = useState<ReasoningEffort>('ultra');
      const row = catalog.cliModels.find(model => model.id === 'native-model');
      useReasoningEffortGuard(effort, setEffort, 'native-model', 'codex', undefined, row?.supportedReasoningEfforts,
        catalog.cliReasoningCapabilitiesUnconfirmed);
      return { ...catalog, effort };
    });
    expect(result.current.effort).toBe('ultra');
    act(() => vi.advanceTimersByTime(16_000));
    expect(result.current.cliModelsError).toBe('timeout');
    expect(result.current.effort).toBe('ultra');
    expect(isCodexUltraCapabilityUnconfirmed('native-model', result.current.effort)).toBe(true);
    act(() => result.current.refreshCliModels('codex'));
    emitCliModels({ provider: 'codex', success: true,
      models: [{ id: 'native-model', label: 'Native', supportedReasoningEfforts: ['high', 'ultra'] }] });
    expect(result.current.effort).toBe('ultra');
    expect(isCodexUltraCapabilityUnconfirmed('native-model', result.current.effort)).toBe(false);
    act(() => result.current.refreshCliModels('codex'));
    emitCliModels({ provider: 'codex', success: true, models: [] });
    expect(result.current.effort).toBe('high');
  });

  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    __resetCliModelsCacheForTests();
    setSessionClaudeModelCatalog(null);
    installRuntimeProviderDispatchers();
  });

  afterEach(() => {
    delete window.setCliModels;
    __resetCliModelsCacheForTests();
    vi.useRealTimers();
  });

  it('carries picker capabilities through normalization, sends, refreshes and mode switches', () => {
    const { result } = renderHook(() => useCliModels('claude'));
    const small = 'ccs-claude-a--glm-flash';
    const large = 'ccs-claude-haiku-provider--glm-pro';
    expect(apply1MContextSuffix(large, true)).toBe(large);
    emitCliModels({ success: true, provider: 'claude', models: [
      { id: small, supports1MContext: false }, { id: large, supports1MContext: true },
    ] });
    expect(result.current.cliModels[1].supports1MContext).toBe(true);
    expect(modelSupports1MContext(small)).toBe(false);
    expect(apply1MContextSuffix(small + '[1M]', true)).toBe(small);
    expect(apply1MContextSuffix(large, true)).toBe(large + '[1m]');
    expect(apply1MContextSuffix(large, false)).toBe(large);
    emitCliModels({ success: true, provider: 'claude', models: [{ id: large, supports1MContext: false }] });
    expect(apply1MContextSuffix(large, true)).toBe(large);
    emitCliModels({ success: true, provider: 'claude', models: [] });
    expect(modelSupports1MContext(large)).toBe(false);
    expect(modelSupports1MContext('claude-sonnet-5')).toBe(true);
    expect(modelSupports1MContext('claude-haiku-4-5')).toBe(false);
  });

  it('fetches the codex catalog when the codex provider is active', () => {
    renderHook(() => useCliModels('codex'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('codex_native_list_models', expect.stringContaining('"requestId"'));
  });

  it('reloads a bound Codex catalog after deferred switching and rejects the previous native response', () => {
    const { result } = renderHook(() => useCliModels('codex', 'session'));
    const original = JSON.parse(sendBridgeEventMock.mock.calls.at(-1)?.[1] as string) as { requestId: string };
    const nativeReply = (requestId: string, model: string) => act(() => window.dispatchEvent(new CustomEvent('codex-native-data', {
      detail: { requestType: 'codex_native_list_models', requestId, data: [{ model, displayName: model }] },
    })));
    nativeReply(original.requestId, 'supplier-a-model');
    expect(result.current.cliModels[0].id).toBe('supplier-a-model');
    sendBridgeEventMock.mockClear();
    const snapshot = (busy: boolean) => act(() => window.dispatchEvent(new CustomEvent('session-supplier-snapshot', {
      detail: { provider: 'codex', supplierId: 'b', bindingToken: 'binding-b', busy },
    })));
    snapshot(true);
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    snapshot(false);
    expect(sendBridgeEventMock).toHaveBeenCalledWith('codex_native_list_models', expect.any(String));
    const current = JSON.parse(sendBridgeEventMock.mock.calls.at(-1)?.[1] as string) as { requestId: string };
    nativeReply(original.requestId, 'stale-model');
    expect(result.current.cliModels.some(model => model.id === 'stale-model')).toBe(false);
    nativeReply(current.requestId, 'supplier-b-model');
    expect(result.current.cliModels[0].id).toBe('supplier-b-model');
    sendBridgeEventMock.mockClear();
    snapshot(false);
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    act(() => window.updateActiveCodexProvider?.(JSON.stringify({ id: 'unrelated-global-provider' })));
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    expect(result.current.cliModels[0].id).toBe('supplier-b-model');
    act(() => window.dispatchEvent(new CustomEvent('session-supplier-snapshot', {
      detail: { provider: 'codex', supplierId: '__codex_cli_login__', bindingToken: 'native-binding', busy: false },
    })));
    sendBridgeEventMock.mockClear();
    act(() => window.updateActiveCodexProvider?.(JSON.stringify({ id: '__codex_cli_login__' })));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('codex_native_list_models', expect.any(String));
  });

  it('publishes a delayed native catalog atomically for restored Ultra and settles unknown models', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    expect(isCodexUltraCapabilityUnconfirmed('native-model', 'ultra')).toBe(true);
    const snapshots: Array<{ status: string; efforts?: readonly string[] }> = [];
    const unsubscribe = subscribeCodexReasoningCapabilities(() => snapshots.push({
      status: getCodexReasoningCapabilities().status, efforts: codexModelReasoningEfforts('native-model'),
    }));
    const requestId = JSON.parse(sendBridgeEventMock.mock.calls.at(-1)![1]).requestId;
    act(() => window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
      requestType: 'codex_native_list_models', requestId,
      data: [{ model: 'native-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] }],
    } })));
    expect(snapshots).toEqual([{ status: 'ready', efforts: ['high', 'ultra'] }]);
    expect(isCodexUltraCapabilityUnconfirmed('custom-model', 'ultra')).toBe(false);
    expect(codexModelReasoningEfforts('custom-model')).toBeUndefined();
    act(() => result.current.refreshCliModels('codex'));
    expect(isCodexUltraCapabilityUnconfirmed('native-model', 'ultra')).toBe(false);
    expect(isCodexUltraCapabilityUnconfirmed('custom-model', 'ultra')).toBe(true);
    unsubscribe();
  });

  it.each([true, false])('distinguishes unsupported models from failed discovery (success: %s)', success => {
    renderHook(() => useCliModels('codex'));
    emitCliModels({ provider: 'codex', models: [], success, ...(success ? {} : { error: 'unavailable' }) });
    expect(getCodexReasoningCapabilities().status).toBe(success ? 'ready' : 'unavailable');
    expect(isCodexUltraCapabilityUnconfirmed('custom-model', 'ultra')).toBe(!success);
  });

  it('discards partial native capabilities when a later catalog page fails', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    const requestId = JSON.parse(sendBridgeEventMock.mock.calls.at(-1)![1]).requestId;
    act(() => window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
      requestType: 'codex_native_list_models', requestId, nextCursor: 'page-two',
      data: [{ model: 'custom-ultra', supportedReasoningEfforts: ['high', 'ultra'] }],
    } })));
    expect(result.current.cliModelsLoading).toBe(true);
    expect(isCodexUltraCapabilityUnconfirmed('custom-ultra', 'ultra')).toBe(true);
    act(() => window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
      requestType: 'codex_native_list_models', requestId, error: 'second page failed',
    } })));
    expect(result.current.cliModels).toEqual(CODEX_MODELS);
    expect(result.current.cliCatalogHasEntries).toBe(false);
    expect(result.current.cliModelsError).toBe('second page failed');
    expect(codexModelReasoningEfforts('custom-ultra')).toBeUndefined();
    expect(isCodexUltraCapabilityUnconfirmed('custom-ultra', 'ultra')).toBe(true);
  });

  it('settles capability loading on timeout or unmount and retries on remount', () => {
    vi.useFakeTimers();
    const first = renderHook(() => useCliModels('codex'));
    act(() => vi.advanceTimersByTime(15_000));
    expect(getCodexReasoningCapabilities().status).toBe('unavailable');
    first.unmount();
    const second = renderHook(() => useCliModels('codex'));
    expect(getCodexReasoningCapabilities().status).toBe('loading');
    second.unmount();
    expect(getCodexReasoningCapabilities().status).toBe('unavailable');
  });

  it('keeps confirmed capabilities on a refresh timeout without deciding unknown models', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCliModels('codex'));
    emitCliModels({ provider: 'codex', models: [{ id: 'native-model', supportedReasoningEfforts: ['high', 'ultra'] }] });
    act(() => result.current.refreshCliModels('codex'));
    act(() => vi.advanceTimersByTime(15_000));
    expect(codexModelReasoningEfforts('native-model')).toEqual(['high', 'ultra']);
    expect(getCodexReasoningCapabilities().status).toBe('unavailable');
    expect(isCodexUltraCapabilityUnconfirmed('custom-model', 'ultra')).toBe(true);
  });

  it('revokes previous native capabilities and request IDs when the active provider changes', () => {
    renderHook(() => useCliModels('codex'));
    emitCliModels({ provider: 'codex', models: [{ id: 'native-model', supportedReasoningEfforts: ['high', 'ultra'] }] });
    const previousRequestId = JSON.parse(sendBridgeEventMock.mock.calls.at(-1)![1]).requestId;
    act(() => window.updateActiveCodexProvider?.('{}'));
    expect(isCodexUltraCapabilityUnconfirmed('native-model', 'ultra')).toBe(true);
    act(() => window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
      requestType: 'codex_native_list_models', requestId: previousRequestId,
      data: [{ model: 'native-model', supportedReasoningEfforts: ['ultra'] }],
    } })));
    expect(codexModelReasoningEfforts('native-model')).toBeUndefined();
    expect(getCodexReasoningCapabilities().status).toBe('loading');
  });

  it('fetches the grok catalog when the grok provider is active', () => {
    renderHook(() => useCliModels('grok'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'grok');
  });

  it('fetches the settings.json model picker for claude', () => {
    renderHook(() => useCliModels('claude'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'claude');
  });

  it('uses a bound conversation catalog while ignoring late global catalog replies and switches', () => {
    const { result } = renderHook(() => useCliModels('claude', 'session'));
    expect(sendBridgeEventMock).not.toHaveBeenCalledWith('get_cli_models', 'claude');
    expect(result.current.cliModelsLoaded).toBe(false);
    act(() => setSessionClaudeModelCatalog({ models: [{ id: 'bound-route', label: 'Bound Route', supports1MContext: true }],
      defaultModel: 'bound-route', replaceBuiltInOptions: true }));
    expect(result.current.cliModels[0].id).toBe('bound-route');
    expect(result.current.cliDefaultModel).toBe('bound-route');
    expect(result.current.cliModelsReplaceBuiltIns).toBe(true);
    emitCliModels({ provider: 'claude', success: true, models: [{ id: 'global-route' }], modelMapping: { sonnet: 'global-model' } });
    act(() => window.updateActiveProvider?.(JSON.stringify({ id: 'global-provider' })));
    expect(result.current.cliModels[0].id).toBe('bound-route');
    expect(apply1MContextSuffix('bound-route', true)).toBe('bound-route[1m]');
    expect(readClaudeModelMapping()).toEqual({});
    const refresh = vi.fn();
    window.addEventListener('session-suppliers-refresh', refresh);
    act(() => result.current.refreshCliModels('claude'));
    window.removeEventListener('session-suppliers-refresh', refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sendBridgeEventMock).not.toHaveBeenCalledWith('get_cli_models', 'claude');
    act(() => setSessionClaudeModelCatalog(null));
    expect(result.current.cliModels).toEqual([]);
    expect(result.current.cliModelsLoaded).toBe(false);
  });

  it('replaces old aggregation mappings with fresh route and direct mappings even without picker entries', () => {
    writeClaudeModelMapping({ sonnet: 'ccs-claude-provider-a--glm-pro', opus: 'ccs-claude-provider-a--glm-pro' });
    renderHook(() => useCliModels('claude'));
    emitCliModels({ success: true, provider: 'claude', models: [], modelMapping: { sonnet: 'claude-sonnet-5', sonnetName: 'GLM Flash', fable: 'claude-fable-5', fableName: 'GLM Pro' } });
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'claude-sonnet-5', sonnetName: 'GLM Flash', fable: 'claude-fable-5', fableName: 'GLM Pro' });
    act(() => window.dispatchEvent(new Event('focus')));
    emitCliModels({ success: true, provider: 'claude', models: [], modelMapping: { sonnet: 'glm-flash', opus: 'glm-pro' } });
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'glm-flash', opus: 'glm-pro' });
    emitCliModels({ success: true, provider: 'claude', models: [], modelMapping: {} });
    expect(readClaudeModelMapping()).toEqual({});
  });

  it('keeps the last mapping on failed loads and drops unrecognized bridge fields', () => {
    writeClaudeModelMapping({ sonnet: 'glm-flash' });
    renderHook(() => useCliModels('claude'));
    emitCliModels({ success: false, provider: 'claude', models: [], modelMapping: {} });
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'glm-flash' });
    emitCliModels({ success: true, provider: 'claude', models: [], modelMapping: { sonnet: 'new-flash', secret: 'do not store', opus: 123 } });
    expect(readClaudeModelMapping()).toEqual({ sonnet: 'new-flash' });
  });

  it('accepts an empty Claude catalog without repeatedly fetching it', () => {
    const { result } = renderHook(() => useCliModels('claude'));
    emitCliModels({ success: true, provider: 'claude', models: [], replaceBuiltInOptions: true });
    expect(result.current.cliModelsReplaceBuiltIns).toBe(true);
    expect(result.current.cliModels).toEqual([]);
    expect(result.current.cliModelsLoading).toBe(false);
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates Claude routes and replacement mode when the active provider changes', () => {
    const { result } = renderHook(() => useCliModels('claude'));
    emitCliModels({ success: true, provider: 'claude', models: [{ id: 'ccs-claude-a--glm-5.3', label: 'GLM（A）' }], replaceBuiltInOptions: true });
    expect(result.current.cliModelsReplaceBuiltIns).toBe(true);
    act(() => window.updateActiveProvider?.('{}'));
    expect(result.current.cliModels).toEqual([]);
    expect(result.current.cliModelsReplaceBuiltIns).toBe(false);
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
    emitCliModels({ success: true, provider: 'claude', models: [] });
    expect(result.current.cliModelsReplaceBuiltIns).toBe(false);
  });

  it.each(['pending', 'failure', 'timeout'] as const)(
    'clears Claude context capabilities immediately on provider switch while reload is %s',
    (reloadState) => {
      vi.useFakeTimers();
      const route = 'ccs-claude-a--glm-pro';
      const { result } = renderHook(() => useCliModels('claude'));
      emitCliModels({ success: true, provider: 'claude', models: [{ id: route, supports1MContext: true }] });
      expect(apply1MContextSuffix(route, true)).toBe(`${route}[1m]`);

      act(() => window.updateActiveProvider?.('{}'));
      // Do not wait for the new catalog: requests during loading must be safe too.
      expect(modelSupports1MContext(route)).toBe(false);
      expect(apply1MContextSuffix(`${route}[1M]`, true)).toBe(route);
      expect(result.current.cliModelsLoading).toBe(true);

      if (reloadState === 'failure') {
        emitCliModels({ success: false, provider: 'claude', error: 'unavailable' });
      } else if (reloadState === 'timeout') {
        act(() => vi.advanceTimersByTime(15_000));
        expect(result.current.cliModelsError).toBe('timeout');
      }
      expect(modelSupports1MContext(route)).toBe(false);
      expect(apply1MContextSuffix(route, true)).toBe(route);

      emitCliModels({ success: true, provider: 'claude', models: [{ id: route, supports1MContext: true }] });
      expect(apply1MContextSuffix(route, true)).toBe(`${route}[1m]`);
    },
  );

  it('invalidates Claude capabilities even while another CLI is selected', () => {
    renderHook(() => useCliModels('grok'));
    const route = 'ccs-claude-a--glm-pro';
    emitCliModels({ success: true, provider: 'claude', models: [{ id: route, supports1MContext: true }] });
    expect(modelSupports1MContext(route)).toBe(true);
    act(() => window.updateActiveProvider?.('{}'));
    expect(modelSupports1MContext(route)).toBe(false);
    expect(sendBridgeEventMock).not.toHaveBeenCalledWith('get_cli_models', 'claude');
  });

  it('reloads a local Claude picker when returning from cc-switch to the IDE', () => {
    const { result } = renderHook(() => useCliModels('claude'));
    emitCliModels({ success: true, provider: 'claude', models: [{ id: 'ccs-claude-a--glm', label: 'GLM（A）' }], replaceBuiltInOptions: true });
    act(() => window.dispatchEvent(new Event('focus')));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
    expect(result.current.cliModelsLoading).toBe(true);
    emitCliModels({ success: true, provider: 'claude', models: [] });
    expect(result.current.cliModelsLoaded).toBe(true);
    expect(result.current.cliModelsReplaceBuiltIns).toBe(false);
    expect(result.current.cliModels).toEqual([]);
  });

  it('falls back to the static CODEX_MODELS list before the catalog arrives', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    expect(result.current.cliModels).toEqual(CODEX_MODELS);
    expect(result.current.cliModelsLoading).toBe(true);
  });

  it('stores the codex catalog and defaultModel from the backend payload', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' }],
    });
    expect(result.current.cliModels).toEqual([
      { id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' },
    ]);
    expect(result.current.cliDefaultModel).toBe('kimi-k3');
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBeNull();
  });

  it('accepts the authorized native model/list projection', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-native-data', {
        detail: {
          requestType: 'codex_native_list_models',
          requestId: JSON.parse(sendBridgeEventMock.mock.calls.at(-1)![1]).requestId,
          data: [{ id: 'internal-catalog-id', model: 'native-model', displayName: 'Native model', description: 'native' },
            { id: 'hidden', model: 'hidden-model', hidden: true }],
        },
      }));
    });
    expect(result.current.cliModels).toEqual([
      { id: 'native-model', label: 'Native model', description: 'native' },
    ]);
    expect(result.current.cliModelsError).toBeNull();
  });

  it('falls back to CODEX_MODELS when the codex payload has no models (official provider)', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'gpt-5.6-sol',
      models: [],
    });
    expect(result.current.cliModels).toEqual(CODEX_MODELS);
    expect(result.current.cliDefaultModel).toBe('gpt-5.6-sol');
  });

  it('keeps kimi fallback behavior intact', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'kimi');
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
  });

  it('records backend errors and supports manual retry for codex', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    emitCliModels({ success: false, provider: 'codex', error: 'node missing', models: [] });
    expect(result.current.cliModelsError).toBe('node missing');
    expect(result.current.cliModels).toEqual(CODEX_MODELS);

    sendBridgeEventMock.mockClear();
    act(() => {
      result.current.refreshCliModels('codex');
    });
    expect(sendBridgeEventMock).toHaveBeenCalledWith('codex_native_list_models', expect.stringContaining('"requestId"'));
  });

  it('keeps failed discovery retryable after the picker remounts without treating it as an unsupported model', () => {
    const first = renderHook(() => useCliModels('codex'));
    emitCliModels({ provider: 'codex', success: false, error: 'offline', models: [] });
    first.unmount();
    const second = renderHook(() => useCliModels('codex'));
    expect(second.result.current.cliModelsError).toBe('offline');
    expect(second.result.current.cliReasoningCapabilitiesUnconfirmed).toBe(true);
    act(() => second.result.current.refreshCliModels('codex'));
    emitCliModels({ provider: 'codex', success: true, models: [] });
    expect(second.result.current.cliModelsError).toBeNull();
    expect(second.result.current.cliReasoningCapabilitiesUnconfirmed).toBe(false);
  });

  it('refetches the codex catalog when the active codex provider changes', () => {
    const { result, rerender } = renderHook(
      ({ provider }) => useCliModels(provider),
      { initialProps: { provider: 'codex' } },
    );
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3' }],
    });
    expect(result.current.modelsByProvider.codex?.length).toBe(1);

    sendBridgeEventMock.mockClear();
    act(() => {
      window.updateActiveCodexProvider?.(JSON.stringify({ id: 'other-provider' }));
    });
    // Cache cleared; effect refetches because the current provider is codex.
    expect(sendBridgeEventMock).toHaveBeenCalledWith('codex_native_list_models', expect.stringContaining('"requestId"'));
    rerender({ provider: 'codex' });
    expect(result.current.modelsByProvider.codex).toBeUndefined();
  });

  it('clears the codex cache without refetching when another provider is active', () => {
    const { result } = renderHook(() => useCliModels('claude'));
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3' }],
    });
    expect(result.current.modelsByProvider.codex?.length).toBe(1);

    sendBridgeEventMock.mockClear();
    act(() => {
      window.updateActiveCodexProvider?.(JSON.stringify({ id: 'other-provider' }));
    });
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    expect(result.current.modelsByProvider.codex).toBeUndefined();
  });

  it('times out into an error state and falls back to static models', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCliModels('codex'));
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBe('timeout');
    expect(result.current.cliModels).toEqual(CODEX_MODELS);
  });

  it('reuses the module cache on remount so history→chat does not re-fetch', () => {
    const first = renderHook(() => useCliModels('opencode'));
    emitCliModels({
      success: true,
      provider: 'opencode',
      defaultModel: 'openai/gpt-5',
      models: [
        { id: 'opencode-default', label: 'OpenCode Default' },
        { id: 'openai/gpt-5', label: 'gpt-5' },
      ],
    });
    expect(first.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    first.unmount();

    sendBridgeEventMock.mockClear();
    const second = renderHook(() => useCliModels('opencode'));
    // Cache already has entries — no bridge round-trip on remount.
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    expect(second.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    expect(second.result.current.cliCatalogHasEntries).toBe(true);
    expect(second.result.current.cliDefaultModel).toBe('openai/gpt-5');
    expect(second.result.current.cliModelsLoading).toBe(false);
  });
});

describe('useOmpRoles', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
    __resetCliModelsCacheForTests();
    installRuntimeProviderDispatchers();
  });

  afterEach(() => {
    delete window.setCliModels;
    __resetCliModelsCacheForTests();
    vi.useRealTimers();
  });

  it('falls back to the static smol/slow/plan roles before any payload arrives', () => {
    const { result } = renderHook(() => {
      useCliModels('omp');
      return useOmpRoles();
    });
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });

  it('populates omp roles from the setCliModels payload', () => {
    const { result } = renderHook(() => {
      useCliModels('omp');
      return useOmpRoles();
    });
    emitCliModels({
      success: true,
      provider: 'omp',
      models: [{ id: 'openai/gpt-5', label: 'gpt-5' }],
      roles: [
        { id: 'smol', label: 'Smol', description: 'openai/gpt-5-mini' },
        { id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' },
      ],
    });
    expect(result.current).toEqual([
      { id: 'smol', label: 'Smol', description: 'openai/gpt-5-mini' },
      { id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' },
    ]);
  });

  it('keeps the static fallback when the payload carries no usable roles', () => {
    const { result } = renderHook(() => {
      useCliModels('omp');
      return useOmpRoles();
    });
    emitCliModels({
      success: true,
      provider: 'omp',
      models: [{ id: 'openai/gpt-5', label: 'gpt-5' }],
      roles: 'not-an-array',
    });
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });

  it('ignores roles payloads for other providers', () => {
    const { result } = renderHook(() => {
      useCliModels('kimi');
      return useOmpRoles();
    });
    emitCliModels({
      success: true,
      provider: 'kimi',
      models: [{ id: 'kimi-k3', label: 'kimi-k3' }],
      roles: [{ id: 'designer', label: 'Designer' }],
    });
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });
});
