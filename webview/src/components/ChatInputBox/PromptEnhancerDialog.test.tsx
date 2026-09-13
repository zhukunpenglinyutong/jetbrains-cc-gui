import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptEnhancerDialog } from './PromptEnhancerDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const map: Record<string, string> = {
        'promptEnhancer.title': 'Enhance Prompt',
        'promptEnhancer.originalPrompt': 'Original Prompt',
        'promptEnhancer.enhancedPrompt': 'Enhanced Prompt',
        'promptEnhancer.enhancing': 'Enhancing...',
        'promptEnhancer.useEnhanced': 'Use Enhanced',
        'promptEnhancer.keepOriginal': 'Keep Original',
        'promptEnhancer.modeLabel': 'Mode',
        'promptEnhancer.modeAuto': 'Auto',
        'promptEnhancer.modeManual': 'Manual',
        'promptEnhancer.modeUnavailable': 'Unavailable',
        'promptEnhancer.providerLabel': 'CLI',
        'promptEnhancer.providerUnresolved': 'No CLI resolved',
        'promptEnhancer.modelLabel': 'Model',
        'promptEnhancer.modelUnresolved': 'Default model',
        'promptEnhancer.openSettings': 'Configure',
        'promptEnhancer.openSettingsTooltip': 'Open settings',
        'promptEnhancer.resolvingUsage': 'Resolving runtime config…',
        'providers.claude.label': 'Claude Code',
        'providers.codex.label': 'Codex',
      };
      return map[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: ({ providerId }: { providerId: string }) => (
    <span data-testid={`provider-icon-${providerId}`}>{providerId}</span>
  ),
}));

describe('PromptEnhancerDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <PromptEnhancerDialog
        isOpen={false}
        isLoading={false}
        originalPrompt="hi"
        enhancedPrompt=""
        onUseEnhanced={vi.fn()}
        onKeepOriginal={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows mode, CLI and model from usageInfo', () => {
    render(
      <PromptEnhancerDialog
        isOpen
        isLoading
        originalPrompt="rewrite this"
        enhancedPrompt=""
        usageInfo={{
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          resolutionSource: 'auto',
        }}
        onUseEnhanced={vi.fn()}
        onKeepOriginal={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('prompt-enhancer-mode').textContent).toContain('Auto');
    expect(screen.getByTestId('prompt-enhancer-provider').textContent).toContain('Claude Code');
    expect(screen.getByTestId('prompt-enhancer-model').textContent).toContain('claude-sonnet-4-6');
  });

  it('shows manual mode label when resolutionSource is manual', () => {
    render(
      <PromptEnhancerDialog
        isOpen
        isLoading={false}
        originalPrompt="x"
        enhancedPrompt="y"
        usageInfo={{
          provider: 'codex',
          model: 'gpt-5.5',
          resolutionSource: 'manual',
        }}
        onUseEnhanced={vi.fn()}
        onKeepOriginal={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('prompt-enhancer-mode').textContent).toContain('Manual');
    expect(screen.getByTestId('prompt-enhancer-provider').textContent).toContain('Codex');
  });

  it('invokes onOpenSettings when configure is clicked', () => {
    const onOpenSettings = vi.fn();
    render(
      <PromptEnhancerDialog
        isOpen
        isLoading={false}
        originalPrompt="x"
        enhancedPrompt="y"
        usageInfo={{
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          resolutionSource: 'auto',
        }}
        onUseEnhanced={vi.fn()}
        onKeepOriginal={vi.fn()}
        onClose={vi.fn()}
        onOpenSettings={onOpenSettings}
      />
    );

    fireEvent.click(screen.getByTestId('prompt-enhancer-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('hides configure button when onOpenSettings is omitted', () => {
    render(
      <PromptEnhancerDialog
        isOpen
        isLoading={false}
        originalPrompt="x"
        enhancedPrompt="y"
        onUseEnhanced={vi.fn()}
        onKeepOriginal={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByTestId('prompt-enhancer-open-settings')).toBeNull();
  });

  it('shows resolving placeholder when usageInfo is missing', () => {
    render(
      <PromptEnhancerDialog
        isOpen
        isLoading
        originalPrompt="x"
        enhancedPrompt=""
        usageInfo={null}
        onUseEnhanced={vi.fn()}
        onKeepOriginal={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId('prompt-enhancer-meta-loading')).toBeTruthy();
    expect(screen.queryByTestId('prompt-enhancer-mode')).toBeNull();
  });
});
