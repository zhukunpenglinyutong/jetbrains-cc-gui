import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HookItem, HookProvider, HookScope } from '../../../types/hooks';
import styles from './style.module.less';
import { issueLabel, PROVIDER_LABELS, scopeLabel } from './utils';

export type ProviderFilter = 'all' | HookProvider;
export type ScopeFilter = 'all' | HookScope;

interface HookToolbarProps {
  provider: ProviderFilter;
  scope: ScopeFilter;
  query: string;
  counts: Record<ProviderFilter, number>;
  loading: boolean;
  onProviderChange: (provider: ProviderFilter) => void;
  onScopeChange: (scope: ScopeFilter) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}

const PROVIDER_FILTERS: ProviderFilter[] = ['all', 'codex', 'claude', 'codemoss'];

const PROVIDER_ICON_CLASSES: Record<HookProvider, string> = {
  codex: 'codicon-terminal',
  claude: 'codicon-symbol-event',
  codemoss: 'codicon-file-code',
};

const PROVIDER_ICON_STYLES: Record<HookProvider, string> = {
  codex: styles.providerIconCodex,
  claude: styles.providerIconClaude,
  codemoss: styles.providerIconCodemoss,
};

export function HookToolbar({
  provider,
  scope,
  query,
  counts,
  loading,
  onProviderChange,
  onScopeChange,
  onQueryChange,
  onRefresh,
}: HookToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.toolbar}>
      <div className={styles.providerFilter} role="group" aria-label={t('settings.hooks.provider')}>
        {PROVIDER_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className={`${styles.providerFilterButton} ${provider === value ? styles.providerFilterButtonActive : ''}`}
            aria-pressed={provider === value}
            onClick={() => onProviderChange(value)}
          >
            <span>{value === 'all' ? t('settings.hooks.all') : PROVIDER_LABELS[value]}</span>
            <span className={styles.filterCount}>{counts[value]}</span>
          </button>
        ))}
      </div>

      <div className={styles.toolbarActions}>
        <label className={styles.searchField}>
          <span className="codicon codicon-search" aria-hidden="true" />
          <span className={styles.visuallyHidden}>{t('settings.hooks.search')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('settings.hooks.searchPlaceholder')}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <select
          className={styles.scopeFilter}
          value={scope}
          aria-label={t('settings.hooks.scope')}
          onChange={(event) => onScopeChange(event.target.value as ScopeFilter)}
        >
          <option value="all">{t('settings.hooks.allScopes')}</option>
          <option value="GLOBAL">{t('settings.hooks.global')}</option>
          <option value="GLOBAL_LOCAL">{t('settings.hooks.globalLocal')}</option>
          <option value="PROJECT">{t('settings.hooks.project')}</option>
          <option value="PROJECT_LOCAL">{t('settings.hooks.projectLocal')}</option>
        </select>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onRefresh}
          disabled={loading}
          title={t('settings.hooks.refresh')}
          aria-label={t('settings.hooks.refresh')}
        >
          <span className={`codicon codicon-refresh ${loading ? 'codicon-modifier-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

interface HookGroupProps {
  provider: HookProvider;
  items: HookItem[];
  toggleLoadingId?: string | null;
  onEdit: (target: HookItem) => void;
  onToggle: (item: HookItem, enabled: boolean) => void;
}

export const HookGroup = memo(function HookGroup({
  provider,
  items,
  toggleLoadingId,
  onEdit,
  onToggle,
}: HookGroupProps) {
  return (
    <section className={styles.hookGroup} aria-labelledby={`hook-group-${provider}`}>
      <div className={styles.groupHeader}>
        <h4 id={`hook-group-${provider}`}>{PROVIDER_LABELS[provider]}</h4>
        <span>{items.length}</span>
      </div>
      <div className={styles.groupList}>
        {items.map((item) => (
          <HookRow
            key={item.sourceId}
            item={item}
            toggleLoading={toggleLoadingId === item.sourceId}
            onEdit={onEdit}
            onToggle={onToggle}
          />
        ))}
      </div>
    </section>
  );
});

interface HookRowProps {
  item: HookItem;
  toggleLoading: boolean;
  onEdit: (item: HookItem) => void;
  onToggle: (item: HookItem, enabled: boolean) => void;
}

const HookRow = memo(function HookRow({ item, toggleLoading, onEdit, onToggle }: HookRowProps) {
  const { t } = useTranslation();
  const validationSummary = item.validationIssues.map((issue) => issueLabel(issue, t)).join('; ');
  const toggleSupported = item.toggleSupported || item.managedToggleSupported;
  const editSupported = item.editSupported !== false;
  const summary = [item.command || t('settings.hooks.noCommand'), item.matcher].filter(Boolean).join(' · ');

  return (
    <article className={`${styles.hookCard} ${!item.enabled ? styles.hookCardDisabled : ''}`}>
      {toggleSupported && (
        <button
          type="button"
          className={`${styles.toggleButton} ${item.enabled ? styles.toggleButtonEnabled : styles.toggleButtonDisabled}`}
          onClick={() => onToggle(item, !item.enabled)}
          disabled={toggleLoading}
          aria-busy={toggleLoading}
          aria-pressed={item.enabled}
          aria-label={item.enabled ? t('settings.hooks.disable') : t('settings.hooks.enable')}
          title={item.enabled ? t('settings.hooks.disable') : t('settings.hooks.enable')}
        >
          <span
            className={`codicon ${toggleLoading
              ? 'codicon-loading codicon-modifier-spin'
              : item.enabled ? 'codicon-check' : 'codicon-circle-slash'}`}
            aria-hidden="true"
          />
        </button>
      )}
      <button
        type="button"
        className={`${styles.hookCardMain} ${toggleSupported ? styles.hookCardMainWithToggle : ''}`}
        onClick={() => onEdit(item)}
        disabled={!editSupported}
        title={editSupported ? t('settings.hooks.editSource') : t('settings.hooks.readOnly')}
        aria-label={`${editSupported ? t('settings.hooks.editSource') : t('settings.hooks.readOnly')}: ${item.event}`}
      >
        <span className={`${styles.providerIcon} ${PROVIDER_ICON_STYLES[item.provider]}`} aria-hidden="true">
          <span className={`codicon ${PROVIDER_ICON_CLASSES[item.provider]}`} />
        </span>
        <span className={styles.rowIdentity}>
          <span className={styles.rowTitleLine}>
            <strong>{item.event}</strong>
            <span className={styles.scopeBadge}>{scopeLabel(item.scope, t)}</span>
            {item.validationIssues.length > 0 && (
              <span className={styles.warningStatus} title={validationSummary}>
                <span className="codicon codicon-warning" aria-hidden="true" />
                {t('settings.hooks.validationWarning')}
              </span>
            )}
            {!editSupported && <span className={styles.readOnlyBadge}>{t('settings.hooks.readOnly')}</span>}
          </span>
          <span className={styles.rowSummary} title={summary}>
            <code>{item.command || t('settings.hooks.noCommand')}</code>
            {item.matcher && <><span aria-hidden="true">·</span><span>{item.matcher}</span></>}
          </span>
        </span>
        <span
          className={`codicon ${editSupported ? 'codicon-chevron-right' : 'codicon-lock'} ${styles.rowIndicator}`}
          aria-hidden="true"
        />
      </button>
    </article>
  );
});
