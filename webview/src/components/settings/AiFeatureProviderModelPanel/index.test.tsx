import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiFeatureProviderModelPanel from './index';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';

const panelStyles = readFileSync(
  'src/components/settings/AiFeatureProviderModelPanel/style.module.less',
  'utf8'
);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.provider
      ? `${key}:${options.provider}`
      : key,
  }),
}));

describe('AiFeatureProviderModelPanel', () => {
  const config: CommitAiConfig = {
    provider: null,
    effectiveProvider: 'codex',
    resolutionSource: 'auto',
    models: {
      claude: 'claude-sonnet-4-6',
      codex: 'gpt-5.5',
    },
    availability: {
      claude: true,
      codex: true,
    },
  };

  it('renders provider select, model select, status hint, and reset button', () => {
    render(
      <AiFeatureProviderModelPanel
        config={config}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    expect(screen.getByText('settings.commit.providerModel.currentProviderAuto:settings.basic.promptEnhancer.provider.codex')).toBeTruthy();
    expect(screen.getByTestId('provider-select-icon')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-actions-row')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-status-hint')).toBeTruthy();
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'settings.commit.providerModel.resetToDefault' })).toBeTruthy();
  });

  it('keeps both rows compact with ellipsis instead of wrapping', () => {
    expect(panelStyles).toMatch(
      /\.selectGroup\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\)\s+minmax\(0,\s*0\.85fr\);/
    );
    expect(panelStyles).toMatch(
      /\.providerSelect,\s*\.modelSelect\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/
    );
    expect(panelStyles).toMatch(
      /\.actionsRow\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*gap:\s*12px;/
    );
    expect(panelStyles).toMatch(
      /\.statusText\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/
    );
  });

  it('calls provider and reset callbacks', () => {
    const onProviderChange = vi.fn();
    const onResetToDefault = vi.fn();

    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'claude',
          effectiveProvider: 'claude',
          resolutionSource: 'manual',
        }}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={onProviderChange}
        onModelChange={vi.fn()}
        onResetToDefault={onResetToDefault}
      />
    );

    const [providerSelect] = screen.getAllByRole('combobox');
    fireEvent.change(providerSelect, { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.commit.providerModel.resetToDefault' }));

    expect(onProviderChange).toHaveBeenCalledWith('codex');
    expect(onResetToDefault).toHaveBeenCalledTimes(1);
  });

  it('calls model change callback from model selector', () => {
    const onModelChange = vi.fn();

    render(
      <AiFeatureProviderModelPanel
        config={config}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={vi.fn()}
        onModelChange={onModelChange}
        onResetToDefault={vi.fn()}
      />
    );

    const [, modelSelect] = screen.getAllByRole('combobox');
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.4' } });

    expect(onModelChange).toHaveBeenCalledWith('gpt-5.4');
  });
});
