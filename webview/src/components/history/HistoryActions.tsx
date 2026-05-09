import { memo } from 'react';
import type { TFunction } from 'i18next';

export interface HistoryActionsProps {
  isSelectionMode: boolean;
  selectedCount: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  isDeepSearching: boolean;
  t: TFunction;
  onEnterSelectionMode: () => void;
  onExitSelectionMode: () => void;
  onToggleSelectAllVisible: () => void;
  onStartDeleteSelected: () => void;
  onDeepSearch: () => void;
}

export const HistoryActions = memo(({
  isSelectionMode,
  selectedCount,
  visibleCount,
  allVisibleSelected,
  isDeepSearching,
  t,
  onEnterSelectionMode,
  onExitSelectionMode,
  onToggleSelectAllVisible,
  onStartDeleteSelected,
  onDeepSearch,
}: HistoryActionsProps) => {
  if (isSelectionMode) {
    return (
      <div className="history-header-actions">
        <button
          className="history-toolbar-btn"
          onClick={onToggleSelectAllVisible}
          disabled={visibleCount === 0}
          title={allVisibleSelected ? t('history.clearSelection') : t('history.selectAll')}
          aria-label={allVisibleSelected ? t('history.clearSelection') : t('history.selectAll')}
        >
          <span className={`codicon ${allVisibleSelected ? 'codicon-clear-all' : 'codicon-check-all'}`}></span>
          <span>{allVisibleSelected ? t('history.clearSelection') : t('history.selectAll')}</span>
        </button>
        <button
          className="history-toolbar-btn history-toolbar-danger"
          onClick={onStartDeleteSelected}
          disabled={selectedCount === 0}
          title={t('history.deleteSelected')}
          aria-label={t('history.deleteSelected')}
        >
          <span className="codicon codicon-trash"></span>
          <span>{t('history.deleteSelected')}</span>
        </button>
        <button
          className="history-toolbar-btn"
          onClick={onExitSelectionMode}
          title={t('history.exitSelectMode')}
          aria-label={t('history.exitSelectMode')}
        >
          <span className="codicon codicon-close"></span>
        </button>
      </div>
    );
  }

  return (
    <div className="history-header-actions">
      <button
        className="history-toolbar-btn"
        onClick={onEnterSelectionMode}
        title={t('history.selectMode')}
        aria-label={t('history.selectMode')}
      >
        <span className="codicon codicon-checklist"></span>
        <span>{t('history.selectMode')}</span>
      </button>
      {/* Deep search button */}
      <button
        className={`history-deep-search-btn ${isDeepSearching ? 'searching' : ''}`}
        onClick={onDeepSearch}
        disabled={isDeepSearching}
        title={t('history.deepSearchTooltip')}
      >
        <span className={`codicon ${isDeepSearching ? 'codicon-sync codicon-modifier-spin' : 'codicon-refresh'}`}></span>
      </button>
    </div>
  );
});

HistoryActions.displayName = 'HistoryActions';
