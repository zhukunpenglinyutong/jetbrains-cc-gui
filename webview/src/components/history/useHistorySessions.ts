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

const deduplicateHistorySessions = (sessions: HistorySessionSummary[]) => {
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
      messageCount: Math.max(preferred.messageCount || 0, fallback.messageCount || 0),
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
  // Sort and filter sessions: favorited on top (by favorite time descending), unfavorited below (original order)
  const sessions = useMemo(() => {
    const rawSessions = deduplicateHistorySessions(historyData?.sessions ?? []);

    // Search filter (case-insensitive)
    const filteredSessions = searchQuery.trim()
      ? rawSessions.filter(s =>
          s.title?.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : rawSessions;

    // Separate favorited and unfavorited sessions
    const favorited = filteredSessions.filter(s => s.isFavorited);
    const unfavorited = filteredSessions.filter(s => !s.isFavorited);

    // Sort favorited sessions by favorite time descending
    favorited.sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));

    // Merge: favorited first, unfavorited after
    return [...favorited, ...unfavorited];
  }, [historyData?.sessions, searchQuery]);

  const infoBar = !historyData
    ? ''
    : t('history.totalSessions', {
        count: sessions.length,
        total: historyData.total ?? 0,
      });

  return { sessions, infoBar };
};
