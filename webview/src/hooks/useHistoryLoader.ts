import { useEffect, useRef } from 'react';
import { sendBridgeEvent } from '../utils/bridge';
import type { HistoryData } from '../types';

export interface UseHistoryLoaderOptions {
  currentView: 'chat' | 'history' | 'settings';
  currentProvider: string;
  historyData: HistoryData | null;
}

export function useHistoryLoader(options: UseHistoryLoaderOptions): void {
  const { currentView, currentProvider, historyData } = options;
  const fallbackTriedRef = useRef(false);
  const requestedPrimaryRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentView !== 'history') {
      fallbackTriedRef.current = false;
      requestedPrimaryRef.current = null;
      return;
    }

    let historyRetryCount = 0;
    const MAX_HISTORY_RETRIES = 30;
    let currentTimer: ReturnType<typeof setTimeout> | null = null;

    const requestHistoryData = () => {
      if (window.sendToJava) {
        requestedPrimaryRef.current = currentProvider;
        sendBridgeEvent('load_history_data', currentProvider);
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
    };
  }, [currentView, currentProvider]);

  useEffect(() => {
    if (currentView !== 'history') {
      return;
    }

    // Fallback load: if current provider returns empty, try the other provider once.
    if (!fallbackTriedRef.current && historyData?.success && (historyData.sessions?.length ?? 0) === 0) {
      const primary = requestedPrimaryRef.current || currentProvider;
      const fallbackProvider = primary === 'codex' ? 'claude' : 'codex';
      fallbackTriedRef.current = true;
      sendBridgeEvent('load_history_data', fallbackProvider);
    }
  }, [currentView, currentProvider, historyData]);
}
