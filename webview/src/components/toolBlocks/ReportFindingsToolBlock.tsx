import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { openFile } from '../../utils/bridge';
import { truncate, truncatePathFromStart } from '../../utils/helpers';
import MarkdownBlock from '../MarkdownBlock';

export interface ReportFinding {
  category?: string;
  failureScenario?: string;
  file?: string;
  line?: number;
  shortSummary?: string;
  summary?: string;
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
  outcome?: 'fixed' | 'skipped' | 'no_change_needed';
}

export interface ReportFindingsData {
  findings: ReportFinding[];
  level?: string;
}

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const readLine = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

// Parser output is normalized to the schema's own enum values, so these maps
// double as both the label i18n key tail and the row/verdict class name.
const VERDICT_LABEL_KEYS = { CONFIRMED: 'confirmed', PLAUSIBLE: 'plausible' } as const;
const OUTCOME_LABEL_KEYS = { fixed: 'fixed', skipped: 'skipped', no_change_needed: 'noChangeNeeded' } as const;

const readVerdict = (value: unknown): ReportFinding['verdict'] => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toUpperCase() as keyof typeof VERDICT_LABEL_KEYS;
  return normalized in VERDICT_LABEL_KEYS ? normalized : undefined;
};

const readOutcome = (value: unknown): ReportFinding['outcome'] => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase() as keyof typeof OUTCOME_LABEL_KEYS;
  return normalized in OUTCOME_LABEL_KEYS ? normalized : undefined;
};

const parseFinding = (value: unknown): ReportFinding | null => {
  if (!isRecord(value)) return null;

  const finding: ReportFinding = {
    category: readText(value.category),
    failureScenario: readText(value.failure_scenario),
    file: readText(value.file),
    line: readLine(value.line),
    shortSummary: readText(value.short_summary),
    summary: readText(value.summary),
    verdict: readVerdict(value.verdict),
    outcome: readOutcome(value.outcome),
  };

  // Drop fully empty entries: a row with no text and no location is pure noise.
  return finding.shortSummary || finding.summary || finding.failureScenario || finding.file
    ? finding
    : null;
};

/**
 * Parse the structured input accepted by the ReportFindings tool.
 * Invalid payloads return null so callers can preserve the generic tool view.
 */
export function parseReportFindingsInput(input?: ToolInput): ReportFindingsData | null {
  if (!input || !Array.isArray(input.findings)) return null;

  const findings = input.findings.map(parseFinding).filter((finding): finding is ReportFinding => finding !== null);
  // Every entry unusable means the payload is garbage; the generic card shows the raw input.
  if (input.findings.length > 0 && findings.length === 0) return null;

  return {
    findings,
    level: readText(input.level),
  };
}

interface ReportFindingRowProps {
  finding: ReportFinding;
}

const ReportFindingRow = memo(function ReportFindingRow({ finding }: ReportFindingRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const title = truncate(
    finding.shortSummary ?? finding.summary ?? finding.failureScenario ?? finding.file ?? t('tools.reportFindings.untitled'),
    140,
  );
  const hasDetails = Boolean(finding.summary || finding.failureScenario);
  const verdictKey = finding.verdict ? VERDICT_LABEL_KEYS[finding.verdict] : undefined;
  const outcomeKey = finding.outcome ? OUTCOME_LABEL_KEYS[finding.outcome] : undefined;
  // No verdict is the norm for inline reviews (verdict is set only after a verify
  // pass), so unverified findings get a neutral outline instead of a warning icon.
  const verdictIcon = verdictKey === 'confirmed'
    ? 'codicon-pass'
    : verdictKey === 'plausible'
      ? 'codicon-warning'
      : 'codicon-circle-outline';

  const handleOpenFile = () => {
    if (finding.file) {
      openFile(finding.file, finding.line);
    }
  };

  return (
    <article className={`report-finding-row ${verdictKey ?? 'unverified'}`}>
      <div className="report-finding-main">
        <div className="report-finding-title-row">
          <span className={`codicon ${verdictIcon} report-finding-verdict-icon`} aria-hidden="true" />
          <span className="report-finding-title" title={finding.shortSummary ?? finding.summary}>
            {title}
          </span>
          {finding.category && (
            <span className="report-finding-category">{finding.category}</span>
          )}
          {verdictKey && (
            <span className={`report-finding-verdict report-finding-verdict-${verdictKey}`}>
              {t(`tools.reportFindings.${verdictKey}`)}
            </span>
          )}
          {outcomeKey && (
            <span className={`report-finding-outcome report-finding-outcome-${finding.outcome}`}>
              {t(`tools.reportFindings.${outcomeKey}`)}
            </span>
          )}
        </div>

        {finding.file && (
          <button
            type="button"
            className="report-finding-location"
            onClick={handleOpenFile}
            title={t('tools.reportFindings.openFile', { filePath: finding.file })}
            aria-label={t('tools.reportFindings.openFile', { filePath: finding.file })}
          >
            <span className="codicon codicon-file-code" aria-hidden="true" />
            <span className="report-finding-path">{truncatePathFromStart(finding.file, 64)}</span>
            {finding.line !== undefined && (
              <span className="report-finding-line">:{finding.line}</span>
            )}
          </button>
        )}
      </div>

      {hasDetails && (
        <button
          type="button"
          className="report-finding-toggle"
          onClick={() => setExpanded((previous) => !previous)}
          aria-expanded={expanded}
          aria-label={expanded
            ? t('tools.reportFindings.collapseFinding')
            : t('tools.reportFindings.expandFinding')}
          title={expanded
            ? t('tools.reportFindings.collapseFinding')
            : t('tools.reportFindings.expandFinding')}
        >
          <span className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`} aria-hidden="true" />
        </button>
      )}

      {expanded && (
        <div className="report-finding-details">
          {finding.summary && (
            <div className="report-finding-detail">
              <div className="report-finding-detail-label">{t('tools.reportFindings.summary')}</div>
              <MarkdownBlock content={finding.summary} />
            </div>
          )}
          {finding.failureScenario && (
            <div className="report-finding-detail">
              <div className="report-finding-detail-label">{t('tools.reportFindings.failureScenario')}</div>
              <MarkdownBlock content={finding.failureScenario} />
            </div>
          )}
        </div>
      )}
    </article>
  );
});

interface ReportFindingsToolBlockProps {
  data: ReportFindingsData;
  result?: ToolResultBlock | null;
  toolId?: string;
}

const ReportFindingsToolBlock = memo(function ReportFindingsToolBlock({
  data,
  result,
  toolId,
}: ReportFindingsToolBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const isDenied = useIsToolDenied(toolId);
  const isCompleted = result !== undefined && result !== null;
  const isError = isDenied || (isCompleted && result?.is_error === true);
  const confirmedCount = data.findings.filter((finding) => finding.verdict === 'CONFIRMED').length;
  const plausibleCount = data.findings.filter((finding) => finding.verdict === 'PLAUSIBLE').length;

  return (
    <div className="task-container report-findings-container">
      <button
        type="button"
        className={`task-header report-findings-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
        aria-label={expanded
          ? t('tools.reportFindings.collapseReport')
          : t('tools.reportFindings.expandReport')}
      >
        <span className="task-title-section">
          <span className="codicon codicon-checklist tool-title-icon" aria-hidden="true" />
          <span className="tool-title-text">{t('tools.reportFindings.title')}</span>
          <span className="report-findings-count">
            {t('tools.reportFindings.findingsCount', { count: data.findings.length })}
          </span>
        </span>
        <span className="task-header-right">
          <span className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
          <span className={`codicon codicon-chevron-${expanded ? 'up' : 'down'} report-findings-chevron`} aria-hidden="true" />
        </span>
      </button>

      {expanded && (
        <div className="report-findings-content">
          {data.findings.length === 0 ? (
            <div className="report-findings-empty" role="status">
              {t('tools.reportFindings.empty')}
            </div>
          ) : (
            <>
              <div className="report-findings-summary" aria-label={t('tools.reportFindings.summaryLabel')}>
                {confirmedCount > 0 && (
                  <span className="report-findings-summary-item confirmed">
                    <span className="codicon codicon-pass" aria-hidden="true" />
                    {t('tools.reportFindings.confirmedCount', { count: confirmedCount })}
                  </span>
                )}
                {plausibleCount > 0 && (
                  <span className="report-findings-summary-item plausible">
                    <span className="codicon codicon-warning" aria-hidden="true" />
                    {t('tools.reportFindings.plausibleCount', { count: plausibleCount })}
                  </span>
                )}
                {data.level && (
                  <span className="report-findings-level">
                    {t('tools.reportFindings.reviewLevel', { level: data.level })}
                  </span>
                )}
              </div>

              <div className="report-findings-list">
                {data.findings.map((finding, index) => (
                  <ReportFindingRow key={index} finding={finding} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});

export default ReportFindingsToolBlock;
