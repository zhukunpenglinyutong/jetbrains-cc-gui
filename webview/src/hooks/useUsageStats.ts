import { useEffect } from 'react';
import { sendBridgeEvent } from '../utils/bridge';

/**
 * Hook for polling usage statistics from the backend
 */
export function useUsageStats(): void {
  useEffect(() => {
    const requestUsageStats = () => {
      if (window.sendToJava) {
        sendBridgeEvent('get_usage_statistics', JSON.stringify({ scope: 'current' }));
      }
    };

    // Initial request
    const initTimer = setTimeout(requestUsageStats, 500);

    // Poll every 60 seconds
    const intervalId = setInterval(requestUsageStats, 60000);

    return () => {
      clearTimeout(initTimer);
      clearInterval(intervalId);
      window.updateActiveProvider = undefined;
    };
  }, []);
}
