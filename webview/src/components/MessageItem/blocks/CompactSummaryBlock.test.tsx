import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { CompactSummaryBlock } from './CompactSummaryBlock';

const t = ((key: string) => key) as TFunction;

it('shows a timed native boundary without offering an imaginary summary', () => {
  const { container, rerender } = render(<CompactSummaryBlock t={t} block={{ type: 'compact_summary',
    title: 'chat.compactSummary.nativeCompleted', content: '',
    metadata: { native: true, status: 'completed', timestamp: '2026-10-02T10:30:00Z', timestampSource: 'item' } }} />);
  expect(screen.getByText('chat.compactSummary.nativeCompleted')).toBeTruthy();
  expect(container.querySelector('time')?.dateTime).toBe('2026-10-02T10:30:00.000Z');
  expect((container.querySelector('.compact-summary-title') as HTMLButtonElement).disabled).toBe(true);
  rerender(<CompactSummaryBlock t={t} block={{ type: 'compact_summary', title: 'chat.compactSummary.nativeCompleted', content: '', metadata: { native: true } }} />);
  expect(screen.getByText('chat.compactSummary.timeUnknown')).toBeTruthy();
  expect(container.querySelector('time')).toBeNull();
});
