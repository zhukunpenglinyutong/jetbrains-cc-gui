import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelConfigSelect, SUBMENU_HOVER_DELAY_MS, SUBMENU_TRIGGER_DELAY_MS } from './ModelConfigSelect';

vi.mock('antd/es/switch', () => ({
  default: ({
    checked,
    disabled,
    onClick,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onClick?: (checked: boolean, e: { stopPropagation: () => void }) => void;
  }) => (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      data-testid="context-switch"
      onClick={() => onClick?.(!checked, { stopPropagation: vi.fn() })}
    />
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; model?: string }) =>
      options?.model ?? options?.defaultValue ?? key,
  }),
}));

const claudeModels = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Default' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fast' },
];

const codexModels = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
];

describe('ModelConfigSelect', () => {
  it('collapses model and effort into one summary trigger', () => {
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    const trigger = screen.getByTestId('model-config-trigger');
    expect(trigger.textContent).toContain('models.claude.sonnet5.label');
    expect(trigger.textContent).toContain('1M');
    expect(trigger.textContent).toContain('High');
    expect(screen.queryByTestId('model-config-dropdown')).toBeNull();
  });

  it('shows the model list flat with the function rows below it', () => {
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));

    // Model list is inline, not behind a fly-out row.
    expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();
    expect(screen.getByTestId('model-option-claude-sonnet-5')).toBeTruthy();
    // All function rows sit below the model list, next to the trigger.
    const modelList = screen.getByTestId('model-selector-dropdown');
    for (const rowTestId of ['model-config-option-context', 'model-config-option-effort']) {
      expect(
        modelList.compareDocumentPosition(screen.getByTestId(rowTestId))
          & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // Effort is a row that opens a fly-out.
    expect(screen.getByTestId('model-config-option-effort')).toBeTruthy();
    expect(screen.getByTestId('model-config-option-effort').textContent).toContain('High');
    expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();
    expect(screen.getByTestId('model-config-option-context')).toBeTruthy();
    expect(screen.queryByTestId('model-config-option-speed')).toBeNull();
  });

  it('selects a model from the inline list without closing the popover', () => {
    const onModelSelect = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={onModelSelect}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    fireEvent.click(screen.getByTestId('model-option-claude-haiku-4-5'));

    expect(onModelSelect).toHaveBeenCalledWith('claude-haiku-4-5');
    expect(screen.getByTestId('model-config-dropdown')).toBeTruthy();
  });

  it('opens the effort fly-out and selects a new level, closing the menu', () => {
    const onReasoningChange = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={onReasoningChange}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    fireEvent.click(screen.getByTestId('model-config-option-effort'));

    expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
    fireEvent.click(screen.getByText('Low'));

    expect(onReasoningChange).toHaveBeenCalledWith('low');
    expect(screen.queryByTestId('model-config-dropdown')).toBeNull();
  });

  it('hides the effort row for Claude models without adaptive thinking', () => {
    render(
      <ModelConfigSelect
        selectedModel="claude-haiku-4-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    expect(screen.queryByTestId('model-config-option-effort')).toBeNull();
    expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();
  });

  it('shows Codex speed as a nested row instead of a toolbar dropdown', () => {
    const onCodexFastModeChange = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="gpt-5.6-sol"
        onModelSelect={vi.fn()}
        models={codexModels}
        currentProvider="codex"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        codexFastMode="normal"
        onCodexFastModeChange={onCodexFastModeChange}
      />,
    );

    const trigger = screen.getByTestId('model-config-trigger');
    expect(trigger.textContent).toContain('GPT-5.6 Sol');
    expect(trigger.textContent).not.toContain('Standard');

    vi.useFakeTimers();
    try {
      fireEvent.click(trigger);
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-speed'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_TRIGGER_DELAY_MS);
      });
      fireEvent.click(screen.getByText('Fast'));

      expect(onCodexFastModeChange).toHaveBeenCalledWith('fast');
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggles Claude 1M context from the trailing rows', () => {
    const onLongContextChange = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={onLongContextChange}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    fireEvent.click(screen.getByTestId('context-switch'));

    expect(onLongContextChange).toHaveBeenCalledWith(false);
  });

  describe('submenu hover delay', () => {
    const dshModels = [
      { id: 'grok-4.6', label: 'Grok 4.6' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash' },
    ];

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not steal the effort submenu while the pointer crosses the preset row', () => {
      render(
        <ModelConfigSelect
          selectedModel="grok-4.6"
          onModelSelect={vi.fn()}
          models={dshModels}
          currentProvider="dsh"
          reasoningEffort="high"
          onReasoningChange={vi.fn()}
          dshPreset=""
          onDshPresetChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('model-config-trigger'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-effort'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_TRIGGER_DELAY_MS);
      });
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();

      fireEvent.mouseEnter(screen.getByTestId('model-config-option-preset'));
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('dsh-preset-dropdown')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(SUBMENU_HOVER_DELAY_MS - 1);
      });
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('dsh-preset-dropdown')).toBeNull();

      // Arriving in the fly-out (which stops mouseenter bubbling) still
      // cancels the pending preset switch.
      fireEvent.mouseOver(screen.getByTestId('reasoning-selector-dropdown'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_HOVER_DELAY_MS);
      });
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('dsh-preset-dropdown')).toBeNull();
    });

    it('dismisses the effort fly-out when the pointer moves onto the flat model list', () => {
      render(
        <ModelConfigSelect
          selectedModel="grok-4.6"
          onModelSelect={vi.fn()}
          models={dshModels}
          currentProvider="dsh"
          reasoningEffort="high"
          onReasoningChange={vi.fn()}
          dshPreset=""
          onDshPresetChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('model-config-trigger'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-effort'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_TRIGGER_DELAY_MS);
      });
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();

      fireEvent.mouseEnter(screen.getByTestId('model-selector-dropdown'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_HOVER_DELAY_MS);
      });
      expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();
      // The main popover stays open; only the fly-out is dismissed.
      expect(screen.getByTestId('model-config-dropdown')).toBeTruthy();
    });

    it('opens the preset submenu after the pointer rests on it, or immediately on click', () => {
      render(
        <ModelConfigSelect
          selectedModel="grok-4.6"
          onModelSelect={vi.fn()}
          models={dshModels}
          currentProvider="dsh"
          reasoningEffort="high"
          onReasoningChange={vi.fn()}
          dshPreset=""
          onDshPresetChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('model-config-trigger'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-effort'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-preset'));

      act(() => {
        vi.advanceTimersByTime(SUBMENU_TRIGGER_DELAY_MS);
      });
      expect(screen.getByTestId('dsh-preset-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();

      fireEvent.click(screen.getByTestId('model-config-option-effort'));
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
    });

    it('delays the first fly-out so a passing pointer does not trigger it', () => {
      render(
        <ModelConfigSelect
          selectedModel="grok-4.6"
          onModelSelect={vi.fn()}
          models={dshModels}
          currentProvider="dsh"
          reasoningEffort="high"
          onReasoningChange={vi.fn()}
          dshPreset=""
          onDshPresetChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('model-config-trigger'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-effort'));

      // Passing by: no fly-out yet.
      act(() => {
        vi.advanceTimersByTime(SUBMENU_TRIGGER_DELAY_MS - 1);
      });
      expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();

      // Leaving the row before the delay cancels the pending open.
      fireEvent.mouseEnter(screen.getByTestId('model-selector-dropdown'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_TRIGGER_DELAY_MS);
      });
      expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();

      // Resting on the row for the full delay opens the fly-out.
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-effort'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_TRIGGER_DELAY_MS);
      });
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
    });
  });
});
