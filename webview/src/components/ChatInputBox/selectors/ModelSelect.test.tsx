import {render, screen} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelSelect} from './ModelSelect';
import type {ModelInfo} from '../types';
import {CLAUDE_MODELS, CODEX_MODELS, modelSupports1MContext} from '../types';
import {STORAGE_KEYS} from '../../../types/provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.model ?? key,
  }),
}));

describe('modelSupports1MContext', () => {
  it('returns true for known Claude non-Haiku models', () => {
    expect(modelSupports1MContext('claude-sonnet-4-6')).toBe(true);
    expect(modelSupports1MContext('claude-opus-4-8')).toBe(true);
    expect(modelSupports1MContext('claude-opus-4-7')).toBe(true);
    expect(modelSupports1MContext('claude-opus-4-6')).toBe(true);
  });

  it('returns false for Haiku', () => {
    expect(modelSupports1MContext('claude-haiku-4-5')).toBe(false);
  });

  it('returns false for unknown models without contextWindow', () => {
    expect(modelSupports1MContext('qwen3-max')).toBe(false);
    expect(modelSupports1MContext('deepseek-v4-pro')).toBe(false);
  });

  it('returns true for model with contextWindow >= 1M', () => {
    const models: ModelInfo[] = [{id: 'qwen3-max', label: 'Qwen3', contextWindow: 1_000_000}];
    expect(modelSupports1MContext('qwen3-max', models)).toBe(true);
  });

  it('returns false for model with contextWindow < 1M', () => {
    const models: ModelInfo[] = [{id: 'qwen3-max', label: 'Qwen3', contextWindow: 200_000}];
    expect(modelSupports1MContext('qwen3-max', models)).toBe(false);
  });

  it('strips [1m] suffix before lookup', () => {
    const models: ModelInfo[] = [{id: 'custom-model', label: 'Custom', contextWindow: 1_000_000}];
    expect(modelSupports1MContext('custom-model[1m]', models)).toBe(true);
  });

  it('returns false for null/undefined', () => {
    expect(modelSupports1MContext(null)).toBe(false);
    expect(modelSupports1MContext(undefined)).toBe(false);
    expect(modelSupports1MContext('')).toBe(false);
  });
});

describe('ModelSelect', () => {
  const sonnetModel: ModelInfo = {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Sonnet 4.6 · Use the default model',
    contextWindow: 200_000,
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it('rerender 后应读取最新的 Claude 模型映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-4');

    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-5' }),
    );

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-5');
  });

  it('没有具体映射时应回退到全局 main 映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ main: 'glm-4.7' }),
    );

    render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-4.7');
  });

  it('Claude 内置模型列表应默认使用不带 [1m] 的 Opus 4.6 ID', () => {
    expect(CLAUDE_MODELS.map((model) => model.id)).toContain('claude-opus-4-6');
    expect(CLAUDE_MODELS.map((model) => model.id)).not.toContain('claude-opus-4-6[1m]');
  });

  it('Codex 内置模型列表应与目标设计一致', () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.2-codex',
      'gpt-5.1-codex-max',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'gpt-5.1-codex-mini',
    ]);
  });
});
