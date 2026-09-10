import { memo } from 'react';
import type { TFunction } from 'i18next';

const SPINNER_STYLE: React.CSSProperties = {
  width: '48px',
  height: '48px',
  margin: '0 auto 16px',
  border: '4px solid rgba(133, 133, 133, 0.2)',
  borderTop: '4px solid #858585',
  borderRadius: '50%',
  animation: 'spin 1s linear infinite',
};

const CENTER_BLOCK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const CENTER_BLOCK_FULL_HEIGHT_STYLE: React.CSSProperties = {
  ...CENTER_BLOCK_STYLE,
  height: '100%',
};

const EMPTY_TEXT_STYLE: React.CSSProperties = {
  textAlign: 'center',
  color: '#858585',
};

const EMPTY_ICON_STYLE: React.CSSProperties = {
  fontSize: '48px',
  marginBottom: '16px',
};

const EMPTY_HINT_STYLE: React.CSSProperties = {
  fontSize: '12px',
  marginTop: '8px',
};

export interface HistoryLoadingStateProps {
  t: TFunction;
}

export const HistoryLoadingState = memo(({ t }: HistoryLoadingStateProps) => {
  return (
    <div className="messages-container" style={CENTER_BLOCK_STYLE}>
      <div style={EMPTY_TEXT_STYLE}>
        <div style={SPINNER_STYLE}></div>
        <div>{t('history.loading')}</div>
      </div>
    </div>
  );
});

HistoryLoadingState.displayName = 'HistoryLoadingState';

export interface HistoryErrorStateProps {
  error?: string;
  t: TFunction;
}

export const HistoryErrorState = memo(({ error, t }: HistoryErrorStateProps) => {
  return (
    <div className="messages-container" style={CENTER_BLOCK_STYLE}>
      <div style={EMPTY_TEXT_STYLE}>
        <div style={EMPTY_ICON_STYLE}>⚠️</div>
        <div>{error ?? t('history.loadFailed')}</div>
      </div>
    </div>
  );
});

HistoryErrorState.displayName = 'HistoryErrorState';

export interface HistoryEmptyStateProps {
  hasSearchQuery: boolean;
  t: TFunction;
}

export const HistoryEmptyState = memo(({ hasSearchQuery, t }: HistoryEmptyStateProps) => {
  // If search returned no results
  if (hasSearchQuery) {
    return (
      <div className="messages-container" style={CENTER_BLOCK_FULL_HEIGHT_STYLE}>
        <div style={EMPTY_TEXT_STYLE}>
          <div style={EMPTY_ICON_STYLE}>🔍</div>
          <div>{t('history.noSearchResults')}</div>
          <div style={EMPTY_HINT_STYLE}>{t('history.tryOtherKeywords')}</div>
        </div>
      </div>
    );
  }

  // If there are no sessions at all
  return (
    <div className="messages-container" style={CENTER_BLOCK_FULL_HEIGHT_STYLE}>
      <div style={EMPTY_TEXT_STYLE}>
        <div style={EMPTY_ICON_STYLE}>📭</div>
        <div>{t('history.noSessions')}</div>
        <div style={EMPTY_HINT_STYLE}>{t('history.noSessionsDesc')}</div>
      </div>
    </div>
  );
});

HistoryEmptyState.displayName = 'HistoryEmptyState';
