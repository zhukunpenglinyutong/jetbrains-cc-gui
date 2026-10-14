import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HookEditorTarget } from '../../../types/hooks';
import ConfirmDialog from '../../ConfirmDialog';
import type { UseHookManagementReturn } from '../hooks';
import HookEditorDialog from './HookEditorDialog';
import { HookGroup, HookToolbar, type ProviderFilter, type ScopeFilter } from './HookList';
import styles from './style.module.less';
import { isHookItem, matchesHookQuery, PROVIDER_ORDER, targetLocation } from './utils';

interface HooksSettingsSectionProps {
  management: UseHookManagementReturn;
}

const NOOP_TOGGLE = () => undefined;

export default function HooksSettingsSection({ management }: HooksSettingsSectionProps) {
  const { t } = useTranslation();
  const {
    catalog,
    hooksLoading: loading,
    loadHooks: onRefresh,
    editor,
    sourceLoading,
    mutationLoading,
    loadHookSource,
    reloadHookSource,
    saveHookSource,
    restoreHookSource,
    canRestore,
    lastBackupPath,
    sourceError,
    mutationError,
    toggleLoadingId,
    toggleError,
    toggleHook,
  } = management;
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selected, setSelected] = useState<HookEditorTarget | null>(null);
  const [draft, setDraft] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const preserveDraftOnReloadRef = useRef(false);
  const activeEditor = selected && editor && targetLocation(editor.item) === targetLocation(selected) ? editor : null;
  const hasDraftChanges = activeEditor?.content !== null && activeEditor?.content !== undefined
    && draft !== activeEditor.content;

  useEffect(() => {
    if (activeEditor && activeEditor.content !== null) {
      if (!preserveDraftOnReloadRef.current) {
        setDraft(activeEditor.content);
      }
      preserveDraftOnReloadRef.current = false;
    }
  }, [activeEditor]);

  useEffect(() => {
    setSelected((current) => {
      if (!current) {
        return current;
      }
      if (!isHookItem(current)) {
        return catalog.sources.find((source) => source.provider === current.provider
          && source.scope === current.scope
          && source.format === current.format
          && source.location === current.location) ?? current;
      }
      const exact = catalog.items.find((item) => item.sourceId === current.sourceId);
      if (exact) {
        return exact;
      }
      const sameIdentity = catalog.items.filter((item) => item.provider === current.provider
        && item.scope === current.scope
        && item.event === current.event
        && item.matcher === current.matcher
        && item.rawLocation === current.rawLocation);
      return sameIdentity.length === 1 ? sameIdentity[0]! : current;
    });
  }, [catalog.items, catalog.sources]);

  const openEditor = useCallback((target: HookEditorTarget) => {
    const location = targetLocation(target);
    setSelected(target);
    setDraft(editor && targetLocation(editor.item) === location && editor.content !== null ? editor.content : '');
    setShowDiff(false);
    setDiscardConfirmOpen(false);
    loadHookSource(target);
  }, [editor, loadHookSource]);

  const closeEditor = useCallback(() => {
    preserveDraftOnReloadRef.current = false;
    setSelected(null);
    setShowDiff(false);
    setDiscardConfirmOpen(false);
  }, []);

  const requestCloseEditor = useCallback(() => {
    if (discardConfirmOpen) {
      return;
    }
    if (hasDraftChanges) {
      setDiscardConfirmOpen(true);
      return;
    }
    closeEditor();
  }, [closeEditor, discardConfirmOpen, hasDraftChanges]);

  const resolveConflict = useCallback((preserveDraft: boolean) => {
    preserveDraftOnReloadRef.current = preserveDraft;
    setShowDiff(preserveDraft);
    reloadHookSource();
  }, [reloadHookSource]);

  const scopedAndSearchedItems = useMemo(
    () => catalog.items.filter((item) => (scope === 'all' || item.scope === scope)
      && matchesHookQuery(item, deferredQuery)),
    [catalog.items, deferredQuery, scope],
  );
  const providerCounts = useMemo<Record<ProviderFilter, number>>(() => ({
    all: scopedAndSearchedItems.length,
    codex: scopedAndSearchedItems.filter((item) => item.provider === 'codex').length,
    claude: scopedAndSearchedItems.filter((item) => item.provider === 'claude').length,
    codemoss: scopedAndSearchedItems.filter((item) => item.provider === 'codemoss').length,
  }), [scopedAndSearchedItems]);
  const filteredItems = useMemo(
    () => provider === 'all' ? scopedAndSearchedItems
      : scopedAndSearchedItems.filter((item) => item.provider === provider),
    [provider, scopedAndSearchedItems],
  );

  const visibleProviders = provider === 'all' ? PROVIDER_ORDER : [provider];
  const visibleGroups = visibleProviders.map((groupProvider) => ({
    provider: groupProvider,
    items: filteredItems.filter((item) => item.provider === groupProvider),
  })).filter((group) => group.items.length > 0);
  const sourceIssueCount = catalog.sources.filter((source) => source.exists
    && source.validationIssues.length > 0).length;

  const changeDraft = useCallback((nextDraft: string) => {
    setDraft(nextDraft);
  }, []);

  return (
    <section className={styles.container}>
      <header className={styles.pageHeader}>
        <h3 className={styles.title}>{t('settings.hooks.title')}</h3>
        <p className={styles.description}>{t('settings.hooks.description')}</p>
      </header>

      <HookToolbar
        provider={provider}
        scope={scope}
        query={query}
        counts={providerCounts}
        loading={loading}
        onProviderChange={setProvider}
        onScopeChange={setScope}
        onQueryChange={setQuery}
        onRefresh={onRefresh}
      />

      {toggleError && (
        <div className={styles.pageNotice} role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{t('settings.hooks.toggleFailed')}: {toggleError}</span>
        </div>
      )}
      {sourceIssueCount > 0 && (
        <div className={styles.pageNotice} role="status">
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('settings.hooks.sourceNotice', { count: sourceIssueCount })}</span>
        </div>
      )}

      {loading ? (
        <div className={styles.loadingList} aria-label={t('settings.hooks.loading')}>
          {[0, 1, 2].map((row) => <span key={row} />)}
        </div>
      ) : visibleGroups.length === 0 ? (
        <div className={styles.emptyState}>
          <span className="codicon codicon-search" aria-hidden="true" />
          <span>{query ? t('settings.hooks.noMatches') : t('settings.hooks.empty')}</span>
        </div>
      ) : (
        <div className={styles.groups}>
          {visibleGroups.map((group) => (
            <HookGroup
              key={group.provider}
              provider={group.provider}
              items={group.items}
              toggleLoadingId={toggleLoadingId}
              onEdit={openEditor}
              onToggle={toggleHook ?? NOOP_TOGGLE}
            />
          ))}
        </div>
      )}

      {selected && (
        <HookEditorDialog
          selected={selected}
          activeEditor={activeEditor}
          draft={draft}
          showDiff={showDiff}
          sourceLoading={sourceLoading}
          mutationLoading={mutationLoading}
          sourceError={sourceError}
          mutationError={mutationError}
          canRestore={canRestore}
          lastBackupPath={lastBackupPath}
          onDraftChange={changeDraft}
          onToggleDiff={() => setShowDiff((current) => !current)}
          onRestore={restoreHookSource}
          onSave={() => saveHookSource(draft)}
          onResolveConflict={resolveConflict}
          onDiscardConflict={closeEditor}
          onRequestClose={requestCloseEditor}
        />
      )}

      <ConfirmDialog
        isOpen={discardConfirmOpen}
        title={t('settings.hooks.discardChangesTitle')}
        message={t('settings.hooks.discardChangesMessage')}
        confirmText={t('settings.hooks.discardDraft')}
        cancelText={t('common.cancel')}
        onConfirm={closeEditor}
        onCancel={() => setDiscardConfirmOpen(false)}
      />
    </section>
  );
}
