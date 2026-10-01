import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConfig, AgentScope } from '../../../types/agent';
import { isAgentEditable } from '../../../types/agent';
import { openFile } from '../../../utils/bridge';
import AgentDetailsView from './AgentDetailsView';
import styles from './style.module.less';

interface AgentSectionProps {
  agents: AgentConfig[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (agent: AgentConfig) => void;
  onDelete: (agent: AgentConfig) => void;
  onExport: () => void;
  onImport: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

const SCOPE_LABEL_KEYS: Record<AgentScope, string> = {
  global: 'settings.agent.scopeGlobal',
  local: 'settings.agent.scopeLocal',
  store: 'settings.agent.scopeStore',
};

/**
 * How many agents each scope contributes to the list below.
 *
 * Computed from the resolved list rather than from a separate server count,
 * because that list has already had precedence applied: a name defined in both
 * the store and the project directory is one agent under the project's scope,
 * and counting the store copy too would double-count it. The numbers therefore
 * add up to the number of rows, which is the only way a user can tell at a
 * glance that nothing is being hidden by shadowing.
 *
 * Entries with no scope are legacy store records from before discovery existed;
 * they are counted as store, since that is where they live and where a write
 * would go.
 */
function countByScope(agents: AgentConfig[]): Record<AgentScope, number> {
  const counts: Record<AgentScope, number> = { global: 0, local: 0, store: 0 };
  for (const agent of agents) {
    counts[agent.scope ?? 'store'] += 1;
  }
  return counts;
}

/**
 * The agents matching a search, or all of them when the query is empty.
 *
 * Client-side on purpose: the whole inventory is already loaded, and a
 * round-trip per keystroke would show a list flickering between scopes. The
 * fields are the ones a user actually types to find something — name,
 * description, prompt text — plus the file name and the warning, because
 * "which one is broken" and "which one was that again" are both questions a
 * search box is the obvious place to ask.
 *
 * Matching is case-insensitive and substring-based, like the skills list. An
 * empty or whitespace-only query is treated as no query, so a stray space does
 * not silently empty the list.
 */
function filterAgents(agents: AgentConfig[], query: string): AgentConfig[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return agents;
  }
  return agents.filter((agent) => {
    const haystacks = [
      agent.name,
      agent.description,
      agent.prompt,
      agent.path,
      agent.warning,
      agent.model,
    ];
    return haystacks.some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(needle)
    );
  });
}

/**
 * A one-line summary of the tools and permissions an agent runs with.
 *
 * Both halves are optional in the specification, so this reports what is
 * actually set rather than describing a default the plugin would have to invent.
 */
function describeConfiguration(agent: AgentConfig, t: (k: string, o?: Record<string, unknown>) => string): string {
  const parts: string[] = [];

  const tools = agent.tools;
  if (Array.isArray(tools)) {
    parts.push(
      tools.length > 0
        ? t('settings.agent.toolsSummaryNamed', { count: tools.length })
        : t('settings.agent.toolsSummaryNone')
    );
  }

  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    parts.push(t('settings.agent.disallowedSummary', { count: agent.disallowedTools.length }));
  }

  if (agent.permissionMode) {
    parts.push(t('settings.agent.permissionSummary', { mode: agent.permissionMode }));
  } else if (agent.background) {
    parts.push(t('settings.agent.backgroundSummary'));
  }

  return parts.join(' · ');
}

export default function AgentSection({
  agents,
  loading,
  onAdd,
  onEdit,
  onDelete,
  onExport,
  onImport,
  onRefresh,
  refreshing,
}: AgentSectionProps) {
  const { t } = useTranslation();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  const visibleAgents = useMemo(
    () => filterAgents(agents, searchQuery),
    [agents, searchQuery]
  );
  // The tally keeps describing the whole inventory rather than the visible
  // subset: "Total" that dropped to the length of a search result would stop
  // answering the question the label asks. The match count beside the search
  // box reports the narrowing instead.
  const isSearching = searchQuery.trim() !== '';

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleMenuToggle = (agentId: string) => {
    setOpenMenuId(openMenuId === agentId ? null : agentId);
  };

  const handleEditClick = (agent: AgentConfig) => {
    setOpenMenuId(null);
    onEdit(agent);
  };

  const handleDeleteClick = (agent: AgentConfig) => {
    setOpenMenuId(null);
    onDelete(agent);
  };

  const handleToggleDetails = (agentId: string) => {
    setExpandedId(expandedId === agentId ? null : agentId);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleWrapper}>
          <h3 className={styles.title}>{t('settings.agent.title')}</h3>
        </div>
        <div className={styles.headerActions} data-testid="agent-header-actions">
          <button
            className={styles.iconButton}
            onClick={onRefresh}
            disabled={refreshing}
            title={t('settings.agent.refresh')}
            aria-label={t('settings.agent.refresh')}
          >
            <span className={`codicon codicon-refresh${refreshing ? ' codicon-modifier-spin' : ''}`} />
          </button>
          <button className={styles.exportButton} onClick={onExport}>
            <span className="codicon codicon-export" />
            {t('settings.agent.export')}
          </button>
          <button className={styles.importButton} onClick={onImport}>
            <span className="codicon codicon-cloud-download" />
            {t('settings.agent.import')}
          </button>
          <button className={styles.addButton} onClick={onAdd}>
            <span className="codicon codicon-add" />
            {t('settings.agent.create')}
          </button>
        </div>
      </div>

      {/* Row two: the filter. Split from the title row because the search box
          and its match count do not fit beside three action buttons at the
          width the settings panel actually gets. */}
      <div className={styles.headerSecondary} data-testid="agent-header-secondary">
        <div className={styles.secondaryLeft}>
          <div className={styles.searchBox}>
            <span className="codicon codicon-search" />
            <input
              type="text"
              className={styles.searchInput}
              placeholder={t('settings.agent.searchPlaceholder')}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label={t('settings.agent.searchPlaceholder')}
            />
            {searchQuery !== '' && (
              <button
                className={styles.searchClear}
                data-testid="agent-search-clear"
                onClick={() => setSearchQuery('')}
                title={t('settings.agent.searchClear')}
                aria-label={t('settings.agent.searchClear')}
              >
                <span className="codicon codicon-close" />
              </button>
            )}
          </div>

          {/* The narrowing is reported here rather than by shrinking the tally
              above, so "Total" keeps describing the whole inventory. */}
          {isSearching && (
            <span className={styles.matchCount} data-testid="agent-match-count">
              {t('settings.agent.matchCount', {
                shown: visibleAgents.length,
                total: agents.length,
              })}
            </span>
          )}

        </div>

      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeaderRow}>
          <h4 className={styles.sectionTitle}>{t('settings.agent.customAgents')}</h4>
          <ScopeCounts agents={agents} t={t} />
        </div>

        {loading ? (
          <div className={styles.loadingState}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.agent.loading')}</span>
          </div>
        ) : agents.length === 0 ? (
          <div className={styles.emptyState}>
            <span>{t('settings.agent.noAgents')}</span>
            <button className={styles.createLink} onClick={onAdd}>
              {t('settings.agent.create')}
            </button>
          </div>
        ) : visibleAgents.length === 0 ? (
          // Distinct from "you have no agents": here the inventory is full and
          // the query is what came up empty, so the fix is to change the query.
          <div className={styles.emptyState} data-testid="agent-no-matches">
            <span>{t('settings.agent.noSearchResults', { query: searchQuery.trim() })}</span>
            <button
              className={styles.createLink}
              data-testid="agent-no-matches-clear"
              onClick={() => setSearchQuery('')}
            >
              {t('settings.agent.searchClear')}
            </button>
          </div>
        ) : (
          <div className={styles.agentList}>
            {visibleAgents.map((agent) => {
              const editable = isAgentEditable(agent);
              const scope = agent.scope;
              const configSummary = describeConfiguration(agent, t);
              const isExpanded = expandedId === agent.id;

              return (
                <div
                  key={agent.id}
                  className={`${styles.agentCard} ${agent.disabled ? styles.agentCardDisabled : ''}`}
                >
                  <div className={styles.agentIcon}>
                    <span className="codicon codicon-robot" />
                  </div>
                  <div className={styles.agentInfo}>
                    <div className={styles.agentNameRow}>
                      <span className={styles.agentName}>{agent.name}</span>
                      {scope && (
                        <span
                          className={`${styles.scopeBadge} ${styles[`scopeBadge_${scope}`] ?? ''}`}
                          data-testid="agent-scope-badge"
                        >
                          {t(SCOPE_LABEL_KEYS[scope], { defaultValue: scope })}
                        </span>
                      )}
                      {agent.readOnly === true && (
                        <span
                          className={styles.readOnlyBadge}
                          title={t('settings.agent.readOnlyHint')}
                        >
                          {t('settings.agent.readOnly')}
                        </span>
                      )}
                      {agent.disabled === true && (
                        <span className={styles.disabledBadge} title={agent.disabledReason}>
                          {t('settings.agent.disabled')}
                        </span>
                      )}
                    </div>

                    {agent.description && (
                      <div className={styles.agentDescription} title={agent.description}>
                        {agent.description}
                      </div>
                    )}

                    {agent.warning && (
                      <div className={styles.agentWarning} role="alert" data-testid="agent-warning">
                        <span className="codicon codicon-warning" />
                        <span>{agent.warning}</span>
                      </div>
                    )}

                    {/* The deny explanation is shown as text, not left in a
                        title attribute: a badge the user cannot read until they
                        happen to hover it is not an explanation. The backend
                        already resolved the rule, so this only ever displays it. */}
                    {agent.disabled === true && agent.disabledReason && (
                      <div className={styles.agentWarning} role="status">
                        <span className="codicon codicon-circle-slash" />
                        <span>{agent.disabledReason}</span>
                      </div>
                    )}

                    <div className={styles.agentMeta}>
                      {agent.model && (
                        <span className={styles.agentModel}>{t('settings.agent.fieldModel')}: {agent.model}</span>
                      )}
                      {configSummary && (
                        <span className={styles.agentConfigSummary}>{configSummary}</span>
                      )}
                    </div>

                    {agent.prompt && !agent.description && (
                      <div className={styles.agentPrompt} title={agent.prompt}>
                        {agent.prompt.length > 50
                          ? agent.prompt.substring(0, 50) + '...'
                          : agent.prompt}
                      </div>
                    )}

                    <div className={styles.agentInlineActions}>
                      {/* The one edit a file-backed agent has. Opening the
                          file is how its author changes it, so the control is
                          on every discovered agent rather than only on the
                          broken ones the warning block happens to contain. It
                          jumps to the blamed line when the parser named one,
                          because a caret at the top of a file whose problem is
                          on line 4 is not a shortcut to the fix. */}
                      <AgentFileLink agent={agent} t={t} />

                      <button
                        className={styles.detailsToggle}
                        onClick={() => handleToggleDetails(agent.id)}
                        aria-expanded={isExpanded}
                      >
                        <span className={`codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
                        {isExpanded
                          ? t('settings.agent.hideDetails')
                          : t('settings.agent.showDetails')}
                      </button>

                    </div>

                    {isExpanded && <AgentDetailsView agent={agent} t={t} />}
                  </div>

                  {/* The menu holds only mutating actions. A file-backed agent
                      has none of them, so it gets no menu rather than a menu of
                      disabled items — the copy action sits inline instead. */}
                  {editable && (
                    <div className={styles.agentActions} ref={openMenuId === agent.id ? menuRef : null}>
                      <button
                        className={styles.menuButton}
                        onClick={() => handleMenuToggle(agent.id)}
                        title={t('settings.agent.menu')}
                      >
                        <span className="codicon codicon-kebab-vertical" />
                      </button>
                      {openMenuId === agent.id && (
                        <div className={styles.dropdownMenu}>
                          <button className={styles.menuItem} onClick={() => handleEditClick(agent)}>
                            <span className="codicon codicon-edit" />
                            {t('common.edit')}
                          </button>
                          <button
                            className={`${styles.menuItem} ${styles.danger}`}
                            onClick={() => handleDeleteClick(agent)}
                          >
                            <span className="codicon codicon-trash" />
                            {t('common.delete')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The per-scope tally, shown whether or not any agent is broken.
 *
 * A user asking "where do I edit this?" needs to know which kind of agent they
 * are looking at before they can answer, and that is answered by the scope
 * rather than by the row. Counting only the broken ones would hide the answer
 * on a healthy list, which is exactly when the question arises.
 */
function ScopeCounts({
  agents,
  t,
}: {
  agents: AgentConfig[];
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const counts = countByScope(agents);
  const total = agents.length;
  if (total === 0) {
    return null;
  }

  return (
    <div className={styles.scopeCounts} data-testid="agent-scope-counts">
      {(['global', 'local', 'store'] as AgentScope[]).map((scope) => (
        <span key={scope} className={styles.scopeCount} data-testid={`count-${scope}`}>
          <span className={`${styles.scopeCountDot} ${styles[`scopeBadge_${scope}`] ?? ''}`} />
          {t(SCOPE_LABEL_KEYS[scope], { defaultValue: scope })}
          <strong>{counts[scope]}</strong>
        </span>
      ))}
      <span className={styles.scopeCountTotal}>
        {t('settings.agent.totalCount', { defaultValue: 'Total' })}
        <strong>{total}</strong>
      </span>
    </div>
  );
}

/**
 * A link to the backing `.md`, jumping to the line the warning blames.
 *
 * The path comes from the scanner, which resolved it and refused anything
 * outside the discovery root, so this re-opens a file the plugin already read
 * rather than accepting one from anywhere else. No link is offered for a store
 * entry: there is no file behind it.
 */
function AgentFileLink({ agent, t }: { agent: AgentConfig; t: (k: string, o?: Record<string, unknown>) => string }) {
  if (typeof agent.path !== 'string' || agent.path.length === 0) {
    return null;
  }
  // Jump to the line the parser blamed when there is one. Otherwise the caret
  // would land at the top of a file whose problem is on line 4.
  //
  // A line number has to be a positive integer. A fractional one would build a
  // "file.md:2.5" locator the backend cannot resolve, so the editor would open
  // the file and silently drop the jump — worse than not asking for one.
  const line =
    typeof agent.warningLine === 'number' &&
    Number.isInteger(agent.warningLine) &&
    agent.warningLine > 0
      ? agent.warningLine
      : undefined;
  const fileName = agent.path.split(/[\\/]/).pop() || agent.path;

  return (
    <button
      type="button"
      className={styles.fileLink}
      onClick={() => openFile(agent.path as string, line)}
      title={
        line !== undefined
          ? `${t('settings.agent.openAtLine', { path: agent.path, line })}`
          : `${t('settings.agent.openFile')}: ${agent.path}`
      }
      aria-label={t('settings.agent.openFile')}
    >
      <span className="codicon codicon-go-to-file" />
      <span>{fileName}</span>
      {line !== undefined && <span className={styles.fileLinkLine}>:{line}</span>}
    </button>
  );
}
