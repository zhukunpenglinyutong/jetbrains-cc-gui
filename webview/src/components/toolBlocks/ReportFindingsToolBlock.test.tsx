import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolInput } from '../../types';
import ReportFindingsToolBlock, { parseReportFindingsInput } from './ReportFindingsToolBlock';

const bridgeMocks = vi.hoisted(() => ({
  openFile: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; filePath?: string; level?: string }) => {
      const translations: Record<string, string> = {
        'tools.reportFindings.title': 'Report Findings',
        'tools.reportFindings.confirmed': 'Confirmed',
        'tools.reportFindings.plausible': 'To review',
        'tools.reportFindings.fixed': 'Fixed',
        'tools.reportFindings.skipped': 'Skipped',
        'tools.reportFindings.noChangeNeeded': 'No change needed',
        'tools.reportFindings.empty': 'No findings',
        'tools.reportFindings.summaryLabel': 'Review summary',
        'tools.reportFindings.summary': 'Summary',
        'tools.reportFindings.failureScenario': 'Failure scenario',
        'tools.reportFindings.expandFinding': 'Expand finding',
        'tools.reportFindings.collapseFinding': 'Collapse finding',
        'tools.reportFindings.expandReport': 'Expand findings report',
        'tools.reportFindings.collapseReport': 'Collapse findings report',
        'tools.reportFindings.untitled': 'Untitled finding',
      };
      if (key === 'tools.reportFindings.findingsCount') {
        return `${options?.count ?? 0} findings`;
      }
      if (key === 'tools.reportFindings.confirmedCount') {
        return `${options?.count ?? 0} confirmed`;
      }
      if (key === 'tools.reportFindings.plausibleCount') {
        return `${options?.count ?? 0} to review`;
      }
      if (key === 'tools.reportFindings.reviewLevel') {
        return `Review level: ${options?.level ?? ''}`;
      }
      if (key === 'tools.reportFindings.openFile') {
        return `Open ${options?.filePath ?? ''}`;
      }
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../../hooks/useIsToolDenied', () => ({
  useIsToolDenied: () => false,
}));

vi.mock('../../utils/bridge', () => ({
  openFile: bridgeMocks.openFile,
}));

vi.mock('../MarkdownBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="finding-markdown">{content}</div>,
}));

describe('parseReportFindingsInput', () => {
  it('normalizes the structured findings payload', () => {
    const data = parseReportFindingsInput({
      level: 'high',
      findings: [{
        category: 'security',
        failure_scenario: 'An attacker can submit an unauthenticated request.',
        file: 'src/MetaInit.java',
        line: 747,
        short_summary: 'Unauthenticated entity creation',
        summary: 'The endpoint can create an entity without checking the caller.',
        verdict: 'CONFIRMED',
        outcome: 'fixed',
      }],
    });

    expect(data).toEqual({
      level: 'high',
      findings: [{
        category: 'security',
        failureScenario: 'An attacker can submit an unauthenticated request.',
        file: 'src/MetaInit.java',
        line: 747,
        shortSummary: 'Unauthenticated entity creation',
        summary: 'The endpoint can create an entity without checking the caller.',
        verdict: 'CONFIRMED',
        outcome: 'fixed',
      }],
    });
  });

  it('rejects malformed payloads so the generic renderer can take over', () => {
    expect(parseReportFindingsInput({ findings: '{not-json' })).toBeNull();
    expect(parseReportFindingsInput({ findings: { file: 'src/App.tsx' } })).toBeNull();
    expect(parseReportFindingsInput({})).toBeNull();
  });
});

describe('ReportFindingsToolBlock', () => {
  it('renders findings as readable rows and opens their file location', () => {
    const data = parseReportFindingsInput({
      findings: [
        {
          category: 'security',
          failure_scenario: 'An attacker can submit an unauthenticated request.',
          file: 'src/MetaInit.java',
          line: 747,
          short_summary: 'Unauthenticated entity creation',
          summary: 'The endpoint can create an entity without checking the caller.',
          verdict: 'CONFIRMED',
        },
        {
          category: 'correctness',
          file: 'src/SessionState.java',
          line: 42,
          short_summary: 'Stale state survives a reset',
          verdict: 'PLAUSIBLE',
        },
      ],
    });

    render(<ReportFindingsToolBlock data={data!} result={{ type: 'tool_result' }} />);

    expect(screen.getByText('Report Findings')).toBeTruthy();
    expect(screen.getByText('2 findings')).toBeTruthy();
    expect(screen.getByText('Unauthenticated entity creation')).toBeTruthy();
    expect(screen.getByText('Stale state survives a reset')).toBeTruthy();
    expect(screen.getByText('security')).toBeTruthy();
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.getByText('To review')).toBeTruthy();
    expect(screen.getByText('src/MetaInit.java')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open src/MetaInit.java' }));
    expect(bridgeMocks.openFile).toHaveBeenCalledWith('src/MetaInit.java', 747);
  });

  it('reveals the summary and failure scenario only after expanding a finding', () => {
    const data = parseReportFindingsInput({
      findings: [{
        file: 'src/App.tsx',
        short_summary: 'Invalid state transition',
        summary: 'The state transition accepts an invalid input.',
        failure_scenario: 'When the callback runs twice, the second call uses stale data.',
      }],
    });

    render(<ReportFindingsToolBlock data={data!} result={{ type: 'tool_result' }} />);

    expect(screen.queryByText('The state transition accepts an invalid input.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand finding' }));
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText('The state transition accepts an invalid input.')).toBeTruthy();
    expect(screen.getByText('Failure scenario')).toBeTruthy();
    expect(screen.getByText('When the callback runs twice, the second call uses stale data.')).toBeTruthy();
  });

  it('shows an explicit empty state and can collapse the report', () => {
    render(
      <ReportFindingsToolBlock
        data={{ findings: [] }}
        result={{ type: 'tool_result' }}
      />,
    );

    expect(screen.getByText('No findings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse findings report' }));
    expect(screen.queryByText('No findings')).toBeNull();
  });

  it('keeps malformed input available to the generic renderer', () => {
    const malformedInput = { findings: 42 } as unknown as ToolInput;
    expect(parseReportFindingsInput(malformedInput)).toBeNull();
  });
});
