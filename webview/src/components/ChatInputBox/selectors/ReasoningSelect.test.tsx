import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ReasoningSelect } from './ReasoningSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

describe('ReasoningSelect', () => {
  beforeEach(() => localStorage.clear());
  it('shows and selects effort for a cc-switch aggregate route', () => {
    const onChange = vi.fn();
    render(<ReasoningSelect value="high" onChange={onChange} currentProvider="claude" selectedModel="ccs-claude-provider-a--glm-pro[1M]" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Max')).toBeTruthy();
    expect(screen.getByText('XHigh')).toBeTruthy();
    fireEvent.click(screen.getByText('Low'));
    expect(onChange).toHaveBeenCalledWith('low');
  });

  it.each(['glm-pro', 'claude-sonnet-5'])('shows and selects xhigh/max for direct/route mapping %s', (model) => {
    writeClaudeModelMapping({ sonnet: model });
    const onChange = vi.fn();
    render(<ReasoningSelect value="high" onChange={onChange} currentProvider="claude" selectedModel="claude-sonnet-5" />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('XHigh'));
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Max'));
    expect(onChange).toHaveBeenCalledWith('xhigh');
    expect(onChange).toHaveBeenCalledWith('max');
  });
  it('shows and selects max for Codex', () => {
    const onChange = vi.fn();

    render(
      <ReasoningSelect
        value={'xhigh'}
        onChange={onChange}
        currentProvider={'codex'}
        selectedModel={'gpt-5.6-sol'}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Max'));

    expect(onChange).toHaveBeenCalledWith('max');
  });

  it('shows max for namespaced GPT-5.6 Codex models regardless of case', () => {
    render(
      <ReasoningSelect
        value={'xhigh'}
        onChange={vi.fn()}
        currentProvider={'codex'}
        selectedModel={'PPIO/PA/GPT-5.6-SOL'}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Max')).toBeTruthy();
  });

  it('keeps max hidden for Codex models that do not support it', () => {
    render(
      <ReasoningSelect
        value={'xhigh'}
        onChange={vi.fn()}
        currentProvider={'codex'}
        selectedModel={'gpt-5.5'}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('Max')).toBeNull();
  });

  it('keeps max hidden when the Codex model is unknown', () => {
    render(
      <ReasoningSelect
        value={'xhigh'}
        onChange={vi.fn()}
        currentProvider={'codex'}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('Max')).toBeNull();
  });

  it('shows max for custom GPT-5.6 model suffixes', () => {
    render(
      <ReasoningSelect
        value={'xhigh'}
        onChange={vi.fn()}
        currentProvider={'codex'}
        selectedModel={'ppio/pa/gpt-5.6-sol-preview'}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Max')).toBeTruthy();
  });

  it('shows xhigh but not max for Grok CLI', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="grok"
        selectedModel="grok-4.6"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('XHigh')).toBeTruthy();
    expect(screen.queryByText('Max')).toBeNull();
  });

  it('shows xhigh and max for Claude Opus 4.8', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-opus-4-8"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('XHigh')).toBeTruthy();
    expect(screen.getByText('Max')).toBeTruthy();
  });

  it('shows max but not xhigh for Claude Sonnet 4.6', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-sonnet-4-6"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('XHigh')).toBeNull();
    expect(screen.getByText('Max')).toBeTruthy();
  });

  it('shows max but not xhigh for Claude Sonnet 5', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-sonnet-5"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('XHigh')).toBeNull();
    expect(screen.getByText('Max')).toBeTruthy();
  });

  it('resets unavailable effort when selected Claude model changes', () => {
    const onChange = vi.fn();

    render(
      <ReasoningSelect
        value="xhigh"
        onChange={onChange}
        currentProvider="claude"
        selectedModel="claude-sonnet-4-6"
      />,
    );

    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('hides for Claude models without effort support', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-haiku-4-5"
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not force a scrollbar on the embedded submenu when all levels fit', () => {
    const trigger = document.createElement('div');
    trigger.getBoundingClientRect = () => ({
      x: 20,
      y: 80,
      top: 80,
      left: 20,
      bottom: 108,
      right: 200,
      width: 180,
      height: 28,
      toJSON() {
        return {};
      },
    });

    render(
      <ReasoningSelect
        embedded
        triggerRef={{ current: trigger }}
        value="high"
        onChange={vi.fn()}
        currentProvider="kimi"
        selectedModel="kimi-k3"
      />,
    );

    const dropdown = screen.getByTestId('reasoning-selector-dropdown');
    expect(dropdown.style.overflowY).not.toBe('auto');
    expect(dropdown.style.maxHeight).toBe('');
  });
});
