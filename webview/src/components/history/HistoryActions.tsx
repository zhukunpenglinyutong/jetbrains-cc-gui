import { memo } from 'react';
import type { TFunction } from 'i18next';

export interface HistoryActionsProps {
  isSelectionMode: boolean;
  selectedCount: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  isDeepSearching: boolean;
  isConvertingAll: boolean;
  convertibleCount: number;
  t: TFunction;
  onEnterSelectionMode: () => void;
  onExitSelectionMode: () => void;
  onToggleSelectAllVisible: () => void;
  onStartDeleteSelected: () => void;
  onDeepSearch: () => void;
  onConvertAllToCliSessions: () => void;
}

export const HistoryActions = memo(({
  isSelectionMode,
  selectedCount,
  visibleCount,
  allVisibleSelected,
  isDeepSearching,
  isConvertingAll,
  convertibleCount,
  t,
  onEnterSelectionMode,
  onExitSelectionMode,
  onToggleSelectAllVisible,
  onStartDeleteSelected,
  onDeepSearch,
  onConvertAllToCliSessions,
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

  // One tooltip source for both title and aria-label: an assistive tech user must get
  // the "nothing to convert" explanation too, not just a count of zero.
  const convertAllTooltip = convertibleCount > 0
    ? t('history.convertAllToCliSessionsTooltip', { count: convertibleCount })
    : t('history.convertAllToCliSessionsEmptyTooltip', {
        defaultValue: 'No SDK or VS Code sessions to convert. Only sessions created by the SDK or the VS Code extension can be turned into CLI entries; sessions created directly by the Claude Code CLI are already resumable.',
      });

  return (
    <div className="history-header-actions">
      {/* Convert every SDK-created session to a CLI entry. The active session is
          excluded server-side: the SDK still appends to its jsonl, so rewriting it
          would drop those messages onto the old inode.

          The button is always rendered, even with nothing to convert. Hiding it made the
          feature undiscoverable: the panel only lists the current project's sessions, so
          anyone whose convertible sessions live in another project saw no button at all and
          had no way to learn the feature existed. A disabled button plus an explanatory
          tooltip keeps the affordance visible and states the reason in place.
          It is also disabled while a batch is running, so the user sees that the click
          was accepted instead of being free to queue a second identical conversion.

          The tooltip sits on a wrapper span as well as on the button: Chromium/JCEF does
          not surface the native title of a disabled control, which is exactly the state the
          "nothing to convert" explanation exists for. The wrapper stays hoverable, so the
          explanation is actually reachable. The button keeps its aria-label, which is how
          assistive tech gets the same text without depending on hover. */}
      <span title={convertAllTooltip}>
        <button
          className="history-toolbar-btn"
          onClick={onConvertAllToCliSessions}
          disabled={convertibleCount === 0 || isConvertingAll}
          title={convertAllTooltip}
          aria-label={convertAllTooltip}
        >
          <span className="codicon codicon-arrow-swap"></span>
          <span>{convertibleCount > 0
            ? t('history.convertAllToCliSessions', { count: convertibleCount })
            : t('history.convertAllToCliSessionsLabel', {
                defaultValue: 'Convert all to CLI',
              })}</span>
        </button>
      </span>
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
        aria-label={t('history.deepSearchTooltip')}
      >
        <span className={`codicon ${isDeepSearching ? 'codicon-sync codicon-modifier-spin' : 'codicon-refresh'}`}></span>
      </button>
    </div>
  );
});

HistoryActions.displayName = 'HistoryActions';
