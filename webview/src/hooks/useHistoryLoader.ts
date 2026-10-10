import { useEffect } from 'react';
import { sendBridgeEvent } from '../utils/bridge';
import type { HistoryData, HistorySessionSummary } from '../types';
import { isGuardianReviewThread } from '../utils/codexThreadVisibility';
import { isKnownHistoryMessageCount, sumKnownHistoryMessages } from '../utils/historyMessageCount';

const MAX_NATIVE_COUNT_REQUESTS = 4;
const NATIVE_COUNT_TIMEOUT_MS = 125_000;
const NATIVE_COUNT_CACHE_TTL_MS = 60_000;

interface NativeCountJob {
  session: HistorySessionSummary;
  params: Record<string, unknown>;
}

export interface UseHistoryLoaderOptions {
  currentView: 'chat' | 'history' | 'settings';
  currentProvider: string;
}

export function useHistoryLoader(options: UseHistoryLoaderOptions): void {
  const { currentView, currentProvider } = options;

  useEffect(() => {
    if (currentView !== 'history') {
      return;
    }

    let historyRetryCount = 0;
    const MAX_HISTORY_RETRIES = 30;
    let currentTimer: ReturnType<typeof setTimeout> | null = null;
    let nativeSessions: HistorySessionSummary[] = [];
    let nativeCursor: unknown = null;
    let nativePartial = false;
    let nativePublished = false;
    let nativeStopped = false;
    let nativeRowSequence = 0;
    const requestId = `history-${crypto.randomUUID()}`;
    const countQueue: NativeCountJob[] = [];
    const pendingCounts = new Map<string, { job: NativeCountJob; timer: ReturnType<typeof setTimeout> }>();
    let countRequestSequence = 0;
    const countExpirations = new Map<string, number>();

    const publishNativeHistory = (previousById: Map<string, HistorySessionSummary>) => {
      const wasPublished = nativePublished;
      nativePublished = true;
      const listedSessions = nativeSessions;
      const cursor = nativeCursor;
      const partial = nativePartial;
      window.setHistoryData?.((history: HistoryData | null) => {
        if (wasPublished && (history?.source !== 'native' || history.nativeRequestId !== requestId)) return history;
        const currentById = new Map((history?.nativeRequestId === requestId ? history.sessions ?? [] : [])
          .map((session) => [session.sessionId, session]));
        // Pagination must preserve edits and deletions made after the preceding page was published.
        const sessions = listedSessions.flatMap((session) => {
          const previous = previousById.get(session.sessionId);
          const current = currentById.get(session.sessionId);
          if (wasPublished && previous && !current) return [];
          if (!previous || !current) return [session];
          return [{ ...session,
            title: current.title !== previous.title ? current.title : session.title,
            isFavorited: current.isFavorited,
            favoritedAt: current.favoritedAt,
          }];
        });
        return { success: true, source: 'native', nativeRequestId: requestId, sessions,
          total: sumKnownHistoryMessages(sessions), cursor, partial };
      });
    };

    const clearCounts = () => {
      for (const pending of pendingCounts.values()) clearTimeout(pending.timer);
      pendingCounts.clear();
      countQueue.length = 0;
    };

    const dispatchCounts = () => {
      while (pendingCounts.size < MAX_NATIVE_COUNT_REQUESTS && countQueue.length > 0) {
        const job = countQueue.shift()!;
        // Identical overlapping metadata shares work; a changed revision owns a new count.
        if (!nativeSessions.some((session) => session.sessionId === job.session.sessionId
          && session.nativeRevision === job.session.nativeRevision && session.messageCount === undefined)) continue;
        const countRequestId = `${requestId}-count-${++countRequestSequence}`;
        const timer = setTimeout(() => {
          pendingCounts.delete(countRequestId);
          dispatchCounts();
        }, NATIVE_COUNT_TIMEOUT_MS);
        pendingCounts.set(countRequestId, { job, timer });
        const sent = sendBridgeEvent('codex_native_count_thread_messages', JSON.stringify({
          threadId: job.session.sessionId,
          params: job.params,
          requestId: countRequestId,
        }));
        if (!sent) {
          clearTimeout(timer);
          pendingCounts.delete(countRequestId);
        }
      }
    };

    const handleNativeHistory = (event: Event) => {
      if (currentProvider !== 'codex') return;
      const payload = (event as CustomEvent<Record<string, unknown>>).detail;
      if (payload?.requestType === 'codex_native_count_thread_messages') {
        const countRequestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        const pending = pendingCounts.get(countRequestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingCounts.delete(countRequestId);
        const matchesRow = (session: HistorySessionSummary) => session.sessionId === pending.job.session.sessionId
          && session.nativeRevision === pending.job.session.nativeRevision && session.messageCount === undefined;
        if (!payload.error && payload.threadId === pending.job.session.sessionId
          && nativeSessions.some(matchesRow) && isKnownHistoryMessageCount(payload.messageCount)) {
          const messageCount = payload.messageCount;
          countExpirations.set(pending.job.session.sessionId, Date.now() + NATIVE_COUNT_CACHE_TTL_MS);
          nativeSessions = nativeSessions.map((session) => matchesRow(session) ? { ...session, messageCount } : session);
          // Merge into current state so a late count cannot restore a deleted row or replace legacy history.
          window.setHistoryData?.((history: HistoryData | null) => {
            if (history?.source !== 'native' || history.nativeRequestId !== requestId
              || !history.sessions?.some(matchesRow)) return history;
            const sessions = history.sessions.map((session) => matchesRow(session)
              ? { ...session, messageCount } : session);
            return { ...history, sessions, total: sumKnownHistoryMessages(sessions) };
          });
        }
        dispatchCounts();
        return;
      }
      if (!payload || (payload.requestType !== 'codex_native_list_threads'
        && payload.requestType !== 'codex_native_list_threads_page')) return;
      if (payload.requestId && payload.requestId !== requestId) return;
      if (nativeStopped) return;
      const nativeError = typeof payload.error === 'string' ? payload.error : null;
      // Local history remains usable when native config access is inactive;
      // authentication and writer errors stay visible instead of falling back
      // to a second execution source.
      if (nativeError) {
        nativeStopped = true;
        clearCounts();
        if (/inactive|not connected|unavailable/i.test(nativeError)) {
          sendBridgeEvent('load_history_data', currentProvider);
        } else {
          window.setHistoryData?.({ success: false, error: nativeError, source: 'native' });
        }
        return;
      }
      const data = Array.isArray(payload.data) ? payload.data : [];
      const previousById = new Map(nativeSessions.map((session) => [session.sessionId, session]));
      const countJobs: NativeCountJob[] = [];
      const sessions: HistorySessionSummary[] = data.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const row = entry as Record<string, unknown>;
        if (isGuardianReviewThread(row)) return [];
        const sessionId = typeof row.id === 'string' ? row.id : '';
        if (!sessionId) return [];
        const title = [row.name, row.title, row.preview, row.summary]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
          ?? sessionId;
        const rawTimestamp = [row.updatedAt, row.updated_at, row.createdAt, row.created_at]
          .find((value) => typeof value === 'string' || typeof value === 'number');
        const timestamp = typeof rawTimestamp === 'number'
          ? new Date(rawTimestamp * (rawTimestamp < 1e12 ? 1000 : 1)).toISOString()
          : typeof rawTimestamp === 'string' ? rawTimestamp : undefined;
        const previous = previousById.get(sessionId);
        const active = (row.status as { type?: string } | undefined)?.type === 'active';
        const params = { updatedAt: row.updatedAt ?? row.updated_at, path: row.path,
          historyMode: row.historyMode, status: row.status };
        const nativeRevision = `${requestId}:${JSON.stringify(params)}${active ? `:active:${++nativeRowSequence}` : ''}`;
        const session: HistorySessionSummary = {
          ...previous,
          sessionId,
          title,
          provider: 'codex',
          model: typeof row.model === 'string' ? row.model : undefined,
          messageCount: isKnownHistoryMessageCount(row.messageCount) ? row.messageCount
            : nativeRevision === previous?.nativeRevision && !active
              && (countExpirations.get(sessionId) ?? 0) > Date.now() ? previous.messageCount : undefined,
          nativeRevision,
          lastTimestamp: timestamp,
          entrypoint: 'app-server',
        };
        if (session.messageCount === undefined) {
          countJobs.push({ session, params });
        }
        return [session];
      });
      if (payload.requestType === 'codex_native_list_threads_page') {
        const byId = new Map(nativeSessions.map((session) => [session.sessionId, session]));
        for (const session of sessions) {
          byId.set(session.sessionId, session);
        }
        nativeSessions = Array.from(byId.values());
      } else {
        nativeSessions = Array.from(new Map(sessions.map((session) => [session.sessionId, session])).values());
      }
      nativeCursor = payload.nextCursor ?? payload.next_cursor ?? payload.cursor ?? null;
      nativePartial = payload.hasMore === true || payload.has_more === true
        || (nativeCursor !== null && nativeCursor !== undefined);
      publishNativeHistory(previousById);
      for (const job of countJobs) {
        const sameRevision = (other: NativeCountJob) => other.session.sessionId === job.session.sessionId
          && other.session.nativeRevision === job.session.nativeRevision;
        if (!countQueue.some(sameRevision) && !Array.from(pendingCounts.values()).some(({ job: pending }) => sameRevision(pending))) {
          countQueue.push(job);
        }
      }
      dispatchCounts();
    };

    window.addEventListener('codex-native-data', handleNativeHistory);
    window.loadCodexHistoryPage = (cursor: unknown) => {
      if (currentProvider !== 'codex' || cursor === null || cursor === undefined) return;
      sendBridgeEvent('codex_native_list_threads_page', JSON.stringify({ cursor, limit: 50, requestId }));
    };

    const requestHistoryData = () => {
      if (window.sendToJava) {
        if (currentProvider === 'codex') {
          sendBridgeEvent('codex_native_list_threads', JSON.stringify({ requestId }));
        } else {
          sendBridgeEvent('load_history_data', currentProvider);
        }
      } else {
        historyRetryCount++;
        if (historyRetryCount < MAX_HISTORY_RETRIES) {
          currentTimer = setTimeout(requestHistoryData, 100);
        } else {
          console.warn('[Frontend] Failed to load history data: bridge not available after', MAX_HISTORY_RETRIES, 'retries');
        }
      }
    };

    currentTimer = setTimeout(requestHistoryData, 50);

    return () => {
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
      window.removeEventListener('codex-native-data', handleNativeHistory);
      clearCounts();
      window.loadCodexHistoryPage = undefined;
    };
  }, [currentView, currentProvider]);
}
