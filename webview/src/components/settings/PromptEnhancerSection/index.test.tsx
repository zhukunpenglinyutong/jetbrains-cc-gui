import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PromptEnhancerSection from './index';
import type { PromptEnhancerConfig } from '../../../types/promptEnhancer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('PromptEnhancerSection', () => {
  it('renders prompt enhancer settings as a standalone section', () => {
    const config: PromptEnhancerConfig = {
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

    render(
      <PromptEnhancerSection
        promptEnhancerConfig={config}
        onPromptEnhancerProviderChange={vi.fn()}
        onPromptEnhancerModelChange={vi.fn()}
        onPromptEnhancerResetToDefault={vi.fn()}
      />
    );

    expect(screen.getByText('settings.promptEnhancer.title')).toBeTruthy();
    expect(screen.getByText('settings.promptEnhancer.description')).toBeTruthy();
    expect(screen.getByTestId('prompt-enhancer-provider-card')).toBeTruthy();
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'settings.basic.promptEnhancer.resetToDefault' })).toBeTruthy();
  });

  it('calls reset callback from standalone prompt enhancer section', () => {
    const onPromptEnhancerResetToDefault = vi.fn();

    render(
      <PromptEnhancerSection
        promptEnhancerConfig={{
          provider: 'claude',
          effectiveProvider: 'claude',
          resolutionSource: 'manual',
          models: {
            claude: 'claude-opus-4-7',
            codex: 'gpt-5.4',
          },
          availability: {
            claude: true,
            codex: true,
          },
        }}
        onPromptEnhancerProviderChange={vi.fn()}
        onPromptEnhancerModelChange={vi.fn()}
        onPromptEnhancerResetToDefault={onPromptEnhancerResetToDefault}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.basic.promptEnhancer.resetToDefault' }));

    expect(onPromptEnhancerResetToDefault).toHaveBeenCalledTimes(1);
  });
});
