import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextBar } from './ContextBar';

const baseProps = {
  showUsage: true,
  currentProvider: 'gemini',
  selectedModel: 'gemini-3.7-flash-high',
};

afterEach(() => {
  delete window.sendToJava;
});

describe('ContextBar Antigravity quota', () => {
  it('does not probe in the background when chatting or changing models', () => {
    window.sendToJava = vi.fn();
    const { rerender } = render(<ContextBar {...baseProps} />);
    rerender(<ContextBar {...baseProps} selectedModel="claude-sonnet-4-6" />);

    expect(window.sendToJava).not.toHaveBeenCalledWith(expect.stringContaining('get_gemini_plan_usage:'));
  });
});
