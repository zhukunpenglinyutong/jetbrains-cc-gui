import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanUsageIndicator } from './PlanUsageIndicator';

describe('PlanUsageIndicator', () => {
  it('shows Usage — when unavailable', () => {
    render(
      <PlanUsageIndicator
        status="unavailable"
        snapshot={{ present: false, message: 'down' }}
      />,
    );
    expect(screen.getByText(/Usage/)).toBeTruthy();
  });

  it('renders bar percent and short reset on happy path', () => {
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
});
