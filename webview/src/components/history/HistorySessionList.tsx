import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { HistorySessionSummary } from '../../types';
import VirtualList from './VirtualList';
import { HistoryEmptyState } from './HistoryStatusView';

const LIST_WRAPPER_STYLE: React.CSSProperties = {
  flex: 1,
  overflow: 'hidden',
};

export interface HistorySessionListProps {
  sessions: HistorySessionSummary[];
  height: number;
  renderItem: (session: HistorySessionSummary) => React.ReactNode;
  searchQuery: string;
  t: TFunction;
}

export const HistorySessionList = memo(({ sessions, height, renderItem, searchQuery, t }: HistorySessionListProps) => {
  return (
    <div style={LIST_WRAPPER_STYLE}>
      {sessions.length > 0 ? (
        <VirtualList
          items={sessions}
          itemHeight={78}
          height={height}
          renderItem={renderItem}
          getItemKey={(session) => `${session.sessionId}-${session.lastTimestamp ?? '0'}`}
          className="messages-container"
        />
      ) : (
        <HistoryEmptyState hasSearchQuery={!!searchQuery.trim()} t={t} />
      )}
    </div>
  );
});

HistorySessionList.displayName = 'HistorySessionList';
