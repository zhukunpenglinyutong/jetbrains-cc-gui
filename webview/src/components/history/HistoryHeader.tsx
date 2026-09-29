import { memo } from 'react';
import type { TFunction } from 'i18next';
import { HistoryActions } from './HistoryActions';
import { HistoryFilters } from './HistoryFilters';

export interface HistoryHeaderProps {
  isSelectionMode: boolean;
  selectedCount: number;
  infoBar: string;
  allVisibleSelected: boolean;
  visibleCount: number;
  isDeepSearching: boolean;
  isConvertingAll: boolean;
  convertibleCount: number;
  inputValue: string;
  t: TFunction;
  onEnterSelectionMode: () => void;
  onExitSelectionMode: () => void;
  onToggleSelectAllVisible: () => void;
  onStartDeleteSelected: () => void;
  onDeepSearch: () => void;
  onConvertAllToCliSessions: () => void;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const HistoryHeader = memo(({
  isSelectionMode,
  selectedCount,
  infoBar,
  allVisibleSelected,
  visibleCount,
  isDeepSearching,
  isConvertingAll,
  convertibleCount,
  inputValue,
  t,
  onEnterSelectionMode,
  onExitSelectionMode,
  onToggleSelectAllVisible,
  onStartDeleteSelected,
  onDeepSearch,
  onConvertAllToCliSessions,
  onInputChange,
}: HistoryHeaderProps) => {
  return (
    <div className="history-header">
      <div className="history-header-main">
        {isSelectionMode ? (
          <div className="history-selection-summary">
            {t('history.selectedSessions', { count: selectedCount })}
          </div>
        ) : (
          <div className="history-info">{infoBar}</div>
        )}
        <HistoryActions
          isSelectionMode={isSelectionMode}
          selectedCount={selectedCount}
          visibleCount={visibleCount}
          allVisibleSelected={allVisibleSelected}
          isDeepSearching={isDeepSearching}
          isConvertingAll={isConvertingAll}
          convertibleCount={convertibleCount}
          t={t}
          onEnterSelectionMode={onEnterSelectionMode}
          onExitSelectionMode={onExitSelectionMode}
          onToggleSelectAllVisible={onToggleSelectAllVisible}
          onStartDeleteSelected={onStartDeleteSelected}
          onDeepSearch={onDeepSearch}
          onConvertAllToCliSessions={onConvertAllToCliSessions}
        />
      </div>
      {!isSelectionMode && (
        <HistoryFilters
          inputValue={inputValue}
          onInputChange={onInputChange}
          t={t}
        />
      )}
    </div>
  );
});

HistoryHeader.displayName = 'HistoryHeader';
