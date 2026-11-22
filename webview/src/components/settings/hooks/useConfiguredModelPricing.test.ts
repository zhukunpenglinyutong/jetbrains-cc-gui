import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readClaudeModelMapping, setSessionClaudeModelMapping, writeClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { STORAGE_KEYS } from '../../../types/provider';
import { useConfiguredClaudeModelPricing } from './useConfiguredModelPricing';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

describe('useConfiguredClaudeModelPricing', () => {
  afterEach(() => { act(() => { setSessionClaudeModelMapping(null); }); });

  it('keeps global pricing mappings independent from the active conversation and observes global changes', () => {
    writeClaudeModelMapping({ sonnet: 'global-a' });
    setSessionClaudeModelMapping({ sonnet: 'session-only' });
    const { result } = renderHook(() => useConfiguredClaudeModelPricing([]));
    expect(result.current.configuredModels.map(model => model.id)).toEqual(['global-a']);
    act(() => { writeClaudeModelMapping({ sonnet: 'global-b' }); });
    expect(result.current.configuredModels.map(model => model.id)).toEqual(['global-b']);
    expect(readClaudeModelMapping().sonnet).toBe('session-only');
  });
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
  });

  it('exposes unique active Claude mapping models with pricing-only metadata', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING, JSON.stringify({
      sonnet: 'deepseek-v4-pro[1m]',
      opus: 'deepseek-v4-pro[1m]',
      haiku: 'deepseek-v4-flash',
    }));
    localStorage.setItem(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING, JSON.stringify({
      'deepseek-v4-pro': { inputCostPer1M: 0.2 },
    }));

    const { result } = renderHook(() => useConfiguredClaudeModelPricing([]));

    expect(result.current.configuredModels).toEqual([
      {
        id: 'deepseek-v4-flash',
        label: 'deepseek-v4-flash',
        pricing: undefined,
      },
      {
        id: 'deepseek-v4-pro[1m]',
        label: 'deepseek-v4-pro[1m]',
        pricing: { inputCostPer1M: 0.2 },
      },
    ]);
  });

  it('persists configured model pricing by base model id and syncs it to Java', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING, JSON.stringify({
      sonnet: 'deepseek-v4-pro[1m]',
    }));

    const { result } = renderHook(() => useConfiguredClaudeModelPricing([]));

    act(() => {
      result.current.updateConfiguredModelPricing('deepseek-v4-pro[1m]', {
        inputCostPer1M: 0.2,
        outputCostPer1M: 0.8,
      });
    });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.CLAUDE_CONFIGURED_MODEL_PRICING) || '{}')).toEqual({
      'deepseek-v4-pro': {
        inputCostPer1M: 0.2,
        outputCostPer1M: 0.8,
      },
    });
    expect(sendBridgeEventMock).toHaveBeenLastCalledWith('set_custom_model_pricing', JSON.stringify({
      provider: 'claude',
      models: [{
        id: 'deepseek-v4-pro',
        label: 'deepseek-v4-pro',
        pricing: {
          inputCostPer1M: 0.2,
          outputCostPer1M: 0.8,
        },
      }],
    }));
  });

  it('keeps configured model pricing visible even if a user custom model has the same base id', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING, JSON.stringify({
      sonnet: 'deepseek-v4-pro[1m]',
    }));

    const { result } = renderHook(() => useConfiguredClaudeModelPricing([
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek Custom',
      },
    ]));

    expect(result.current.configuredModels).toEqual([{
      id: 'deepseek-v4-pro[1m]',
      label: 'deepseek-v4-pro[1m]',
      pricing: undefined,
    }]);
  });

  it('keeps configured pricing in Java sync payload when user custom models exist', () => {
    localStorage.setItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING, JSON.stringify({
      sonnet: 'deepseek-v4-pro[1m]',
    }));

    const { result } = renderHook(() => useConfiguredClaudeModelPricing([
      {
        id: 'vendor/custom-claude',
        label: 'Custom Claude',
        pricing: { inputCostPer1M: 0.1 },
      },
    ]));

    act(() => {
      result.current.updateConfiguredModelPricing('deepseek-v4-pro[1m]', {
        inputCostPer1M: 0.2,
      });
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
          pricing: { inputCostPer1M: 0.2 },
        },
      ],
    }));
  });
});
