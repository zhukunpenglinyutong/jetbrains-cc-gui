import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n/config';
import { ContextBar } from './ContextBar';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateCodexPlanUsage?: (json: string) => void;
};

const baseProps = {
  showUsage: true,
  selectedModel: 'gpt-5.4',
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  delete w.sendToJava;
  delete w.updateCodexPlanUsage;
});

describe('ContextBar codex plan-usage wiring', () => {
  it('polls get_codex_plan_usage when provider is codex', () => {
    w.sendToJava = vi.fn();
    render(<ContextBar {...baseProps} currentProvider="codex" />);

    expect(w.sendToJava).toHaveBeenCalledWith(expect.stringMatching(/^get_codex_plan_usage:\d+$/));
  });

  it('renders the pushed codex snapshot through PlanUsageIndicator with Codex tooltip title', async () => {
    w.sendToJava = vi.fn();
    render(<ContextBar {...baseProps} currentProvider="codex" />);

    act(() => {
      w.updateCodexPlanUsage?.(JSON.stringify({
        present: true,
        provider: 'codex',
        level: 'pro',
        capacity_pct: 17,
        period_type: '7d',
        reset_at: '2026-12-03T07:00:00Z',
        windows: [{ id: '7d', used_pct: 17, reset_at: '2026-12-03T07:00:00Z', period_type: '7d' }],
      }));
    });
    expect(screen.getByText('17%')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByRole('group'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Codex plan usage');
    expect(tooltip.textContent).toContain('PRO');
    expect(tooltip.textContent).not.toContain('Claude plan usage');
  });

  it('never polls codex plan usage for other providers', () => {
    w.sendToJava = vi.fn();
    render(<ContextBar {...baseProps} currentProvider="claude" />);

    expect(w.sendToJava).not.toHaveBeenCalledWith(
      expect.stringContaining('get_codex_plan_usage'),
    );
  });
});
