import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConfigProvider from 'antd/es/config-provider';
import i18n from '../../i18n/config';
import { formatFullReset, PLAN_USAGE_WINDOW_STORAGE_KEY, type PlanUsageSnapshot } from '../../utils/planUsagePace';
import { PlanUsageIndicator } from './PlanUsageIndicator';

const SNAPSHOT: PlanUsageSnapshot = {
  present: true,
  capacityPct: 51,
  periodType: '5h',
  resetAt: '2026-10-13T07:30:00Z',
  level: 'max',
  windows: [
    { id: '5h', usedPct: 51, resetAt: '2026-10-13T07:30:00Z' },
    { id: '7d', usedPct: 72, resetAt: '2026-10-20T07:30:00Z' },
  ],
};

describe('PlanUsageIndicator', () => {
  beforeEach(async () => {
    localStorage.removeItem(PLAN_USAGE_WINDOW_STORAGE_KEY);
    await i18n.changeLanguage('en');
  });

  it('shows Usage — when unavailable', () => {
    render(
      <PlanUsageIndicator
        status="unavailable"
        snapshot={{ present: false, message: 'down' }}
      />,
    );
    expect(screen.getByText(/Usage/)).toBeTruthy();
  });

  it('keeps dates out of the compact summary', () => {
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          capacityPct: 47,
          resetAt: '2026-07-28T00:00:00Z',
          periodType: '7d',
        }}
      />,
    );
    expect(screen.getByText('47%')).toBeTruthy();
    expect(container.querySelector('.plan-usage-bar')).toBeTruthy();
    expect(container.querySelector('.plan-usage-fill')).toBeTruthy();
    expect(container.querySelector('.plan-usage-reset')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(container.querySelector('.plan-usage')?.textContent).not.toContain('2026');
  });

  it('shows full local reset dates for every known window on hover', async () => {
    render(<PlanUsageIndicator status="ready" snapshot={SNAPSHOT} />);

    fireEvent.mouseEnter(screen.getByRole('group'));
    const tooltip = await screen.findByRole('tooltip');

    expect(tooltip.textContent).toContain('Claude plan usage');
    expect(tooltip.textContent).toContain('MAX');
    expect(tooltip.textContent).toContain('5h · 51% used');
    expect(tooltip.textContent).toContain('7d · 72% used');
    expect(tooltip.textContent).toContain(formatFullReset(SNAPSHOT.resetAt, 'en'));
    expect(tooltip.textContent).toContain(formatFullReset(SNAPSHOT.windows?.[1].resetAt, 'en'));
    expect(tooltip.textContent).toContain('local time');
  });

  it('opens on keyboard focus and closes with Escape', async () => {
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <PlanUsageIndicator status="ready" snapshot={SNAPSHOT} />
      </ConfigProvider>,
    );
    const summary = screen.getByRole('group');

    fireEvent.focus(summary);
    await screen.findByRole('tooltip');
    fireEvent.keyDown(summary, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('preserves period switching and updates the open tooltip after a refresh', async () => {
    const { rerender } = render(<PlanUsageIndicator status="ready" snapshot={SNAPSHOT} />);
    fireEvent.mouseEnter(screen.getByRole('group'));
    await screen.findByRole('tooltip');

    fireEvent.click(screen.getByRole('button', { name: 'Click period label to switch window' }));

    expect(screen.getByText('72%')).toBeTruthy();
    expect(localStorage.getItem(PLAN_USAGE_WINDOW_STORAGE_KEY)).toBe('7d');
    expect(screen.getByRole('tooltip').textContent).toContain('7d · 72% used');

    rerender(<PlanUsageIndicator status="ready" snapshot={{
      ...SNAPSHOT,
      windows: [
        SNAPSHOT.windows![0],
        { id: '7d', usedPct: 81, resetAt: '2026-10-21T08:00:00Z' },
      ],
    }} />);

    expect(screen.getByText('81%')).toBeTruthy();
    expect(screen.getByRole('tooltip').textContent).toContain('7d · 81% used');
    expect(screen.getByRole('tooltip').textContent).toContain(formatFullReset('2026-10-21T08:00:00Z', 'en'));
  });

  it('uses the same tiny percentage in the summary and details', async () => {
    render(<PlanUsageIndicator status="ready" snapshot={{ present: true, capacityPct: 0.2, periodType: '5h' }} />);

    expect(screen.getByText('<1%')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole('group'));
    expect((await screen.findByRole('tooltip')).textContent).toContain('5h · <1% used');
  });

  it('localizes details and flags stale data without inventing a reset time', async () => {
    await i18n.changeLanguage('zh');
    render(<PlanUsageIndicator status="ready" snapshot={{
      present: true,
      capacityPct: 51,
      periodType: '5h',
      resetAt: 'invalid-date',
      stale: true,
    }} />);

    fireEvent.mouseEnter(screen.getByRole('group'));
    const tooltip = await screen.findByRole('tooltip');

    expect(tooltip.textContent).toContain('Claude 额度详情');
    expect(tooltip.textContent).toContain('已使用 51%');
    expect(tooltip.textContent).toContain('刷新失败');
    expect(tooltip.textContent).not.toContain('重置时间');
    expect(tooltip.textContent).not.toContain('Invalid Date');
  });

  it('applies pace color class from TP vs TT', () => {
    // end far future, start far past → TT high → TP low → green
    const far = new Date();
    far.setDate(far.getDate() + 3);
    const start = new Date();
    start.setDate(start.getDate() - 4);
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          capacityPct: 10,
          resetAt: far.toISOString(),
          periodStart: start.toISOString(),
        }}
      />,
    );
    expect(container.querySelector('.pace-green')).toBeTruthy();
  });

  it('returns null when idle', () => {
    const { container } = render(<PlanUsageIndicator status="idle" snapshot={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the balance amount instead of the bar for prepaid vendors', async () => {
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          source: 'deepseek',
          balance: { remaining: 42.5, total: null, used: null, unit: 'CNY' },
        }}
      />,
    );
    expect(screen.getByText('Balance: ¥42.50')).toBeTruthy();
    expect(container.querySelector('.plan-usage-bar')).toBeNull();
    expect(container.querySelector('.plan-usage-balance')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByRole('group'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Balance: ¥42.50');
  });

  it('colors an exhausted balance red and shows totals in the rendered tooltip', async () => {
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          source: 'openrouter',
          balance: { remaining: 0, total: 100, used: 100, unit: 'USD' },
        }}
      />,
    );
    expect(screen.getByText('Balance: $0.00')).toBeTruthy();
    expect(container.querySelector('.plan-usage.pace-red')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByRole('group'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Balance: $0.00');
    expect(tooltip.textContent).toContain('Total $100.00 · Used $100.00');
  });

  it('renders Moonshot international (api.moonshot.ai) balances in USD', async () => {
    render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          source: 'moonshot',
          balance: { remaining: 12.5, total: null, used: null, unit: 'USD' },
        }}
      />,
    );
    expect(screen.getByText('Balance: $12.50')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByRole('group'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Balance: $12.50');
    expect(tooltip.textContent).not.toContain('¥');
  });

  it('prefers windows over balance when both are present', () => {
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          capacityPct: 30,
          windows: [{ id: '5h', usedPct: 30 }],
          balance: { remaining: 5, unit: 'CNY' },
        }}
      />,
    );
    expect(container.querySelector('.plan-usage-bar')).toBeTruthy();
    expect(container.querySelector('.plan-usage-balance')).toBeNull();
  });
});
