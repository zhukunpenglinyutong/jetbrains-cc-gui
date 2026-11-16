import type { AgentConfig } from '../../../types/agent';
import { openFile } from '../../../utils/bridge';
import styles from './style.module.less';

/**
 * Fields shown in the details view, in specification order.
 *
 * Every entry is rendered whether or not it is set: a row that says "not
 * specified" is what makes a discovered agent's configuration readable, since
 * silently dropping absent fields would leave the user unable to tell an
 * unconfigured agent from one the plugin failed to parse.
 */
interface DetailRow {
  key: keyof AgentConfig;
  labelKey: string;
}

/** Fields that are metadata about the definition, not part of the agent itself. */
const METADATA_ROW_KEYS = new Set<keyof AgentConfig>([
  'id',
  'createdAt',
  'path',
  'scope',
  'source',
  'readOnly',
  'disabled',
  'disabledReason',
]);

/**
 * The documented Claude Code subagent frontmatter fields.
 *
 * Mirrors `AGENT_SPECIFICATION_FIELDS` from types/agent.ts plus the plugin's
 * own `prompt`, which has no frontmatter counterpart but is the field a store
 * agent exists to carry.
 */
const SPEC_ROWS: DetailRow[] = [
  { key: 'description', labelKey: 'settings.agent.fieldDescription' },
  { key: 'model', labelKey: 'settings.agent.fieldModel' },
  { key: 'permissionMode', labelKey: 'settings.agent.fieldPermissionMode' },
  { key: 'tools', labelKey: 'settings.agent.fieldTools' },
  { key: 'disallowedTools', labelKey: 'settings.agent.fieldDisallowedTools' },
  { key: 'maxTurns', labelKey: 'settings.agent.fieldMaxTurns' },
  { key: 'skills', labelKey: 'settings.agent.fieldSkills' },
  { key: 'mcpServers', labelKey: 'settings.agent.fieldMcpServers' },
  { key: 'hooks', labelKey: 'settings.agent.fieldHooks' },
  { key: 'memory', labelKey: 'settings.agent.fieldMemory' },
  { key: 'background', labelKey: 'settings.agent.fieldBackground' },
  { key: 'effort', labelKey: 'settings.agent.fieldEffort' },
  { key: 'isolation', labelKey: 'settings.agent.fieldIsolation' },
  { key: 'color', labelKey: 'settings.agent.fieldColor' },
  { key: 'initialPrompt', labelKey: 'settings.agent.fieldInitialPrompt' },
  { key: 'omitClaudeMd', labelKey: 'settings.agent.fieldOmitClaudeMd' },
  { key: 'experimental', labelKey: 'settings.agent.fieldExperimental' },
  { key: 'prompt', labelKey: 'settings.agent.fieldPrompt' },
];

const META_ROWS: DetailRow[] = [
  { key: 'path', labelKey: 'settings.agent.fieldPath' },
];

/**
 * Render a configuration value for display.
 *
 * Strings are truncated rather than dumped: `initialPrompt` and `experimental`
 * can hold a paragraph, and a details panel that grows to fit one hides the
 * fields the user opened it to read.
 */
const MAX_VALUE_LENGTH = 160;

export function formatAgentValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  // Nested structures (hooks, mcpServers, experimental) keep their JSON shape:
  // a list rendered as "[object Object]" would tell the user nothing.
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_VALUE_LENGTH) return text;
  return `${text.substring(0, MAX_VALUE_LENGTH)}…`;
}

interface AgentDetailsViewProps {
  agent: AgentConfig;
  /** Translate; injected so the component stays free of i18n setup details. */
  t: (key: string, options?: Record<string, unknown>) => string;
}

export default function AgentDetailsView({ agent, t }: AgentDetailsViewProps) {
  const renderRows = (rows: DetailRow[]) =>
    rows.filter((row) => !METADATA_ROW_KEYS.has(row.key)).map((row) => {
      const raw = agent[row.key];
      const isEmpty = raw === undefined || raw === null || raw === '';
      const rendered = truncate(formatAgentValue(raw));
      return (
        <div key={row.key} className={styles.detailRow}>
          <span className={styles.detailKey}>{t(row.labelKey, { defaultValue: row.key })}</span>
          {isEmpty ? (
            <span className={styles.detailEmpty}>{t('settings.agent.notSpecified')}</span>
          ) : (
            // Plain text, never raw HTML: agent names, descriptions and
            // prompts come from Markdown files the user did not necessarily
            // write, and i18n interpolation is unescaped (React is the only
            // thing between those bytes and the DOM).
            <span className={styles.detailValue} title={rendered}>
              {rendered}
            </span>
          )}
        </div>
      );
    });

  const visibleMetaRows = META_ROWS.filter((row) => {
    const raw = agent[row.key];
    return raw !== undefined && raw !== null && raw !== '';
  });

  return (
    <div className={styles.details}>
      {renderRows(SPEC_ROWS)}
      {visibleMetaRows.length > 0 && (
        <>
          <div className={styles.detailsDivider} />
          {visibleMetaRows.map((row) => (
            <div key={row.key} className={styles.detailRow}>
              <span className={styles.detailKey}>{t(row.labelKey, { defaultValue: row.key })}</span>
              {/* The file row is a link, not text. The row above the details
                  panel already offers this; repeating it here is what a user who
                  has opened Details to inspect an agent would expect, and it is
                  the same one action rather than a second control. */}
              {row.key === 'path' ? (
                <button
                  type="button"
                  className={styles.detailLink}
                  onClick={() =>
                    openFile(
                      String(agent.path),
                      // Same rule as the row link: a positive integer only, so a
                      // fractional locator never becomes a silent no-op jump.
                      typeof agent.warningLine === 'number' &&
                      Number.isInteger(agent.warningLine) &&
                      agent.warningLine > 0
                        ? agent.warningLine
                        : undefined
                    )
                  }
                  title={String(agent.path)}
                >
                  <span className="codicon codicon-go-to-file" />
                  <span>{truncate(String(agent[row.key]))}</span>
                </button>
              ) : (
                <span className={styles.detailValue} title={String(agent[row.key])}>
                  {truncate(String(agent[row.key]))}
                </span>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
