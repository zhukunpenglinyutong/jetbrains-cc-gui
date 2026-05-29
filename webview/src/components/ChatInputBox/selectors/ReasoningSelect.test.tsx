import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReasoningSelect } from './ReasoningSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

describe('ReasoningSelect', () => {
  it('shows xhigh and max for Claude Opus 4.7', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-opus-4-7"
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

  it('shows OpenCode model variants when the selected model supports them', () => {
    render(
      <ReasoningSelect
        value="default"
        onChange={vi.fn()}
        currentProvider="opencode"
        selectedModel="openai/gpt-5.5"
        openCodeVariantOptions={[
          { id: 'default', label: 'Default' },
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getAllByText('Default').length).toBeGreaterThan(0);
    expect(screen.getByText('Low')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
  });

  it('hides for OpenCode when the selected model has no variants', () => {
    render(
      <ReasoningSelect
        value="default"
        onChange={vi.fn()}
        currentProvider="opencode"
        selectedModel="opencode-default"
        openCodeVariantOptions={[]}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });
});
