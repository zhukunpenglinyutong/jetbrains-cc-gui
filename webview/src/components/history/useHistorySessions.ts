import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { HistoryData, HistorySessionSummary } from '../../types';

const getComparableTimestamp = (timestamp: string | undefined) => {
  if (!timestamp) {
    return 0;
  }
  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? 0 : value;
};

const deduplicateHistorySessions = (sessions: HistorySessionSummary[], nativeHistory: boolean) => {
  const deduplicated = new Map<string, HistorySessionSummary>();

  for (const session of sessions) {
    if (!session?.sessionId) {
      continue;
    }

    const existing = deduplicated.get(session.sessionId);
    if (!existing) {
      deduplicated.set(session.sessionId, session);
      continue;
    }

    const existingTs = getComparableTimestamp(existing.lastTimestamp);
    const incomingTs = getComparableTimestamp(session.lastTimestamp);
    const preferred = incomingTs >= existingTs ? session : existing;
    const fallback = preferred === session ? existing : session;

    deduplicated.set(session.sessionId, {
      ...preferred,
      title: preferred.title || fallback.title,
      // A newer native revision may be unknown or shorter after a rollback; older counts cannot fill it.
      messageCount: nativeHistory ? preferred.messageCount : preferred.messageCount === undefined ? fallback.messageCount
        : fallback.messageCount === undefined ? preferred.messageCount : Math.max(preferred.messageCount, fallback.messageCount),
      isFavorited: preferred.isFavorited || fallback.isFavorited,
      favoritedAt: Math.max(preferred.favoritedAt || 0, fallback.favoritedAt || 0) || undefined,
      provider: preferred.provider || fallback.provider,
      model: preferred.model || fallback.model,
      agent: preferred.agent || fallback.agent,
      entrypoint: preferred.entrypoint || fallback.entrypoint,
    });
  }

  return Array.from(deduplicated.values());
};

export const useHistorySessions = (historyData: HistoryData | null, searchQuery: string, t: TFunction) => {
  // Deduplicated but unsearched. The search box narrows what is *rendered* only: the
  // backend walks the whole project index for the convert-all command, so anything that
  // must mirror the backend's candidate set (the "convert all (N)" count) has to read this
  // list, never the filtered one — otherwise the button claims "nothing to convert" while
  // the click would have converted N sessions.
  const allSessions = useMemo(
    () => deduplicateHistorySessions(historyData?.sessions ?? [], historyData?.source === 'native'),
    [historyData?.sessions, historyData?.source]
  );

  // Sort and filter sessions: favorited on top (by favorite time descending), unfavorited below (original order)
  const sessions = useMemo(() => {
    // Search filter (case-insensitive)
    const filteredSessions = searchQuery.trim()
      ? allSessions.filter(s =>
          s.title?.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : allSessions;

    // Separate favorited and unfavorited sessions
    const favorited = filteredSessions.filter(s => s.isFavorited);
    const unfavorited = filteredSessions.filter(s => !s.isFavorited);

    // Sort favorited sessions by favorite time descending
    favorited.sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));

    // Merge: favorited first, unfavorited after
    return [...favorited, ...unfavorited];
  }, [historyData?.sessions, historyData?.source, searchQuery]);

  const infoBar = !historyData
    ? ''
    : t(historyData.total === undefined ? 'history.totalSessionsOnly' : 'history.totalSessions', {
        count: sessions.length,
        total: historyData.total ?? 0,
      });

  return { sessions, allSessions, infoBar };
};
