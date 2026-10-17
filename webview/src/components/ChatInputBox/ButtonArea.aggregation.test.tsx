import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonArea } from './ButtonArea';
import { DEFAULT_CLAUDE_MODEL_ID, type ModelInfo } from './types';
import { __resetCliModelsCacheForTests } from '../../hooks/providers/useCliModels';

vi.mock('../../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./hooks/useToolbarSelectorCompact', () => ({ useToolbarSelectorCompact: () => false }));
vi.mock('./selectors', () => ({
  ConfigSelect: () => null, ModeSelect: () => null, ProviderSelect: () => null,
  ModelConfigSelect: ({ models }: { models: ModelInfo[] }) => <div data-testid="models">{models.map(model => model.label).join('|')}</div>,
}));

const models = [
  { id: 'ccs-claude-provider-a--grok-4.7', label: 'grok-4.7（供应商 A）' },
  { id: 'ccs-claude-provider-b--glm-5.3', label: 'glm-5.3（供应商 B）' },
];
const emit = (payload: unknown) => act(() => window.setCliModels?.(JSON.stringify(payload)));
const emitPicker = () => emit({ success: true, provider: 'claude', models, defaultModel: models[1].id, replaceBuiltInOptions: true });

describe('cc-switch aggregation in the chat toolbar', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetCliModelsCacheForTests();
  });

  it('replaces family slots and selects the configured route only after the picker arrives', () => {
    const onModelSelect = vi.fn();
    render(<ButtonArea currentProvider="claude" selectedModel={DEFAULT_CLAUDE_MODEL_ID} onModelSelect={onModelSelect} />);
    expect(onModelSelect).not.toHaveBeenCalled();
    emitPicker();
    expect(screen.getByTestId('models').textContent).toBe(models.map(model => model.label).join('|'));
    expect(onModelSelect).toHaveBeenCalledExactlyOnceWith(models[1].id);
  });

  it('keeps a valid saved route when the picker arrives', () => {
    const onModelSelect = vi.fn();
    render(<ButtonArea currentProvider="claude" selectedModel={models[0].id} onModelSelect={onModelSelect} />);
    emitPicker();
    expect(onModelSelect).not.toHaveBeenCalled();
  });

  it('returns to the default Claude slot when cc-switch exits aggregation', () => {
    const onModelSelect = vi.fn();
    render(<ButtonArea currentProvider="claude" selectedModel={models[0].id} onModelSelect={onModelSelect} />);
    emitPicker();
    act(() => window.dispatchEvent(new Event('focus')));
    expect(onModelSelect).not.toHaveBeenCalled();
    emit({ success: true, provider: 'claude', models: [] });
    expect(onModelSelect).toHaveBeenCalledExactlyOnceWith(DEFAULT_CLAUDE_MODEL_ID);
  });

  it('does not discard a saved route when the model list fails to load', () => {
    const onModelSelect = vi.fn();
    render(<ButtonArea currentProvider="claude" selectedModel={models[0].id} onModelSelect={onModelSelect} />);
    emit({ success: false, provider: 'claude', models: [], error: 'Bridge unavailable' });
    expect(onModelSelect).not.toHaveBeenCalled();
  });

  it('refreshes model names across aggregation, route and direct modes without remounting', () => {
    render(<ButtonArea currentProvider="claude" selectedModel={models[0].id} onModelSelect={vi.fn()} />);
    emitPicker();
    expect(screen.getByTestId('models').textContent).toContain('供应商 A');
    act(() => window.dispatchEvent(new Event('focus')));
    emit({ success: true, provider: 'claude', models: [], modelMapping: {
      sonnet: 'claude-sonnet-5[1M]', sonnetName: 'GLM Flash',
      opus: 'claude-opus-5[1M]', opusName: 'GLM Pro',
      fable: 'claude-fable-5[1M]', fableName: 'Fable Pro',
      haiku: 'claude-haiku-4-5', haikuName: 'Fast Model',
    } });
    expect(screen.getByTestId('models').textContent).toContain('GLM Flash');
    expect(screen.getByTestId('models').textContent).toContain('GLM Pro');
    expect(screen.getByTestId('models').textContent).toContain('Fable Pro');
    expect(screen.getByTestId('models').textContent).toContain('Fast Model');
    expect(screen.getByTestId('models').textContent).not.toContain('ccs-claude-');
    act(() => window.dispatchEvent(new Event('focus')));
    emit({ success: true, provider: 'claude', models: [], modelMapping: { sonnet: 'direct-flash', opus: 'direct-pro', fable: 'direct-fable', haiku: 'direct-fast' } });
    expect(screen.getByTestId('models').textContent).toContain('direct-flash');
    expect(screen.getByTestId('models').textContent).not.toContain('GLM Flash');
  });
});
