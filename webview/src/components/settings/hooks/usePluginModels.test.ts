import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../../types/provider';
import { usePluginModels } from './usePluginModels';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

describe('usePluginModels', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
  });

  it('persists custom pricing locally and syncs it to Java for Claude models', () => {
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([
        {
          id: 'vendor/custom-claude',
          label: 'Custom Claude',
          contextWindowTokens: 500_000,
          pricing: {
            inputCostPer1M: 0.2,
            outputCostPer1M: 0.8,
            cacheWriteCostPer1M: 0.25,
            cacheReadCostPer1M: 0.02,
          },
        },
      ]);
    });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) || '[]')).toEqual([
      {
        id: 'vendor/custom-claude',
        label: 'Custom Claude',
        pricing: {
          inputCostPer1M: 0.2,
          outputCostPer1M: 0.8,
          cacheWriteCostPer1M: 0.25,
          cacheReadCostPer1M: 0.02,
        },
      },
    ]);
    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_custom_model_pricing', JSON.stringify({
      provider: 'claude',
      models: [
        {
          id: 'vendor/custom-claude',
          label: 'Custom Claude',
          pricing: {
            inputCostPer1M: 0.2,
            outputCostPer1M: 0.8,
            cacheWriteCostPer1M: 0.25,
            cacheReadCostPer1M: 0.02,
          },
        },
      ],
    }));
  });

  it('drops stale context metadata when reading Claude custom models', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS, JSON.stringify([{
      id: 'vendor/custom-claude',
      label: 'Custom Claude',
      contextWindowTokens: 500_000,
    }]));

    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS));

    expect(result.current.models).toEqual([{
      id: 'vendor/custom-claude',
      label: 'Custom Claude',
    }]);
  });

  it('keeps configured Claude model pricing when syncing user custom models', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING, JSON.stringify({
      'deepseek-v4-pro': {
        inputCostPer1M: 0.2,
        outputCostPer1M: 0.8,
      },
    }));
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([
        {
          id: 'vendor/custom-claude',
          label: 'Custom Claude',
          pricing: { inputCostPer1M: 0.1 },
        },
      ]);
    });

    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_custom_model_pricing', JSON.stringify({
      provider: 'claude',
      models: [
        {
          id: 'vendor/custom-claude',
          label: 'Custom Claude',
          pricing: { inputCostPer1M: 0.1 },
        },
        {
          id: 'deepseek-v4-pro',
          label: 'deepseek-v4-pro',
          pricing: {
            inputCostPer1M: 0.2,
            outputCostPer1M: 0.8,
          },
        },
      ],
    }));
  });

  it('syncs configured pricing after a same-base user custom model so configured model cost still wins', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING, JSON.stringify({
      'deepseek-v4-pro': {
        inputCostPer1M: 0.2,
      },
    }));
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([
        {
          id: 'deepseek-v4-pro[1m]',
          label: 'DeepSeek custom',
          pricing: { inputCostPer1M: 0.3 },
        },
      ]);
    });

    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_custom_model_pricing', JSON.stringify({
      provider: 'claude',
      models: [
        {
          id: 'deepseek-v4-pro[1m]',
          label: 'DeepSeek custom',
          pricing: { inputCostPer1M: 0.3 },
        },
        {
          id: 'deepseek-v4-pro',
          label: 'deepseek-v4-pro',
          pricing: { inputCostPer1M: 0.2 },
        },
      ],
    }));
  });

  it('filters invalid pricing before persisting and syncing Codex models', () => {
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([
        { id: 'valid-codex', label: 'Valid Codex', pricing: { inputCostPer1M: 0.1 } },
        { id: 'invalid-codex', label: 'Invalid Codex', pricing: { inputCostPer1M: -1 } },
      ]);
    });

    const expectedModels = [
      { id: 'valid-codex', label: 'Valid Codex', pricing: { inputCostPer1M: 0.1 } },
    ];

    expect(result.current.models).toEqual(expectedModels);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS) || '[]')).toEqual(expectedModels);
    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_custom_model_pricing', JSON.stringify({
      provider: 'codex',
      models: expectedModels,
    }));
  });

  it('persists and syncs a custom context window alongside pricing', () => {
    const { result } = renderHook(() => usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS));

    act(() => {
      result.current.updateModels([{
        id: 'vendor/context-model',
        label: 'Context Model',
        contextWindowTokens: 500_000,
        pricing: { inputCostPer1M: 0.1 },
      }]);
    });

    const expectedModels = [{
      id: 'vendor/context-model',
      label: 'Context Model',
      contextWindowTokens: 500_000,
      pricing: { inputCostPer1M: 0.1 },
    }];

    expect(result.current.models).toEqual(expectedModels);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS) || '[]')).toEqual(expectedModels);
    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_custom_model_pricing', JSON.stringify({
      provider: 'codex',
      models: expectedModels,
    }));
  });
});
