import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextBar } from './ContextBar';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateGeminiPlanUsage?: (json: string) => void;
};

const baseProps = {
  showUsage: true,
  selectedModel: 'gemini-3.7-flash-high',
};

afterEach(() => {
  delete w.sendToJava;
  delete w.updateGeminiPlanUsage;
});

/**
 * Review L7: the gemini gate + `selectedModel` pass-through are string
 * contracts — `selectedModel` is optional, so TS alone cannot catch a dropped
 * wire (the hook would silently poll with an empty slug → wrong billing
 * family). These tests pin the actual wiring end to end.
 */
describe('ContextBar gemini plan-usage wiring', () => {
  it('polls get_gemini_plan_usage with the selected model slug when provider is gemini', () => {
    w.sendToJava = vi.fn();
    render(<ContextBar {...baseProps} currentProvider="gemini" />);

    expect(w.sendToJava).toHaveBeenCalledWith('get_gemini_plan_usage:gemini-3.7-flash-high');
  });

  it('renders the pushed gemini snapshot through the shared PlanUsageIndicator', () => {
    w.sendToJava = vi.fn();
    render(<ContextBar {...baseProps} currentProvider="gemini" />);

    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify({
        present: true,
        provider: 'gemini',
        capacity_pct: 58,
        period_type: '5h',
        windows: [{ id: 'gemini-5h', used_pct: 58, reset_at: '2026-09-08T18:15:00Z', period_type: '5h' }],
      }));
    });
    expect(screen.getByText('58%')).toBeTruthy();
  });

  it('never polls gemini usage for other providers', () => {
    w.sendToJava = vi.fn();
    render(<ContextBar {...baseProps} currentProvider="claude" />);

    expect(w.sendToJava).not.toHaveBeenCalledWith(
      expect.stringContaining('get_gemini_plan_usage'),
    );
  });
});
