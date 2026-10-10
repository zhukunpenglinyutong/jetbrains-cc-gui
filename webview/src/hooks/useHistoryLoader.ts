import { useEffect } from 'react';
import { sendBridgeEvent } from '../utils/bridge';
import type { HistoryData, HistorySessionSummary } from '../types';
import { isGuardianReviewThread } from '../utils/codexThreadVisibility';

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
    const requestId = `history-${crypto.randomUUID()}`;

    const handleNativeHistory = (event: Event) => {
      if (currentProvider !== 'codex') return;
      const payload = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!payload || (payload.requestType !== 'codex_native_list_threads'
        && payload.requestType !== 'codex_native_list_threads_page')) return;
      if (payload.requestId && payload.requestId !== requestId) return;
      const nativeError = typeof payload.error === 'string' ? payload.error : null;
      // Local history remains usable when native config access is inactive;
      // authentication and writer errors stay visible instead of falling back
      // to a second execution source.
      if (nativeError) {
        if (/inactive|not connected|unavailable/i.test(nativeError)) {
          sendBridgeEvent('load_history_data', currentProvider);
        } else {
          window.setHistoryData?.({ success: false, error: nativeError, source: 'native' });
        }
        return;
      }
      const data = Array.isArray(payload.data) ? payload.data : [];
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
        return [{
          sessionId,
          title,
          provider: 'codex',
          model: typeof row.model === 'string' ? row.model : undefined,
          messageCount: typeof row.messageCount === 'number' ? row.messageCount : 0,
          lastTimestamp: timestamp,
          entrypoint: 'app-server',
        }];
      });
      if (payload.requestType === 'codex_native_list_threads_page') {
        const byId = new Map(nativeSessions.map((session) => [session.sessionId, session]));
        for (const session of sessions) {
          byId.set(session.sessionId, { ...(byId.get(session.sessionId) ?? {}), ...session });
        }
        nativeSessions = Array.from(byId.values());
      } else {
        nativeSessions = sessions;
      }
      nativeCursor = payload.nextCursor ?? payload.next_cursor ?? payload.cursor ?? null;
      const history: HistoryData = {
        success: true,
        source: 'native',
        sessions: nativeSessions,
        total: nativeSessions.length,
        cursor: nativeCursor,
        partial: payload.hasMore === true || payload.has_more === true
          || (nativeCursor !== null && nativeCursor !== undefined),
      };
      window.setHistoryData?.(history);
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
      window.loadCodexHistoryPage = undefined;
    };
  }, [currentView, currentProvider]);
}
