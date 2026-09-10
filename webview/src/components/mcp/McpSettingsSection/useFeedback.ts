/**
 * Toast notifications and refresh log state for the MCP settings panel
 */

import { useState, useCallback } from 'react';
import type { ToastMessage } from '../../Toast';
import type { RefreshLog } from '../types';

export interface UseFeedbackOptions {
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface UseFeedbackReturn {
  toasts: ToastMessage[];
  refreshLogs: RefreshLog[];
  addToast: (message: string, type?: ToastMessage['type']) => void;
  dismissToast: (id: string) => void;
  addLog: (
    message: string,
    type?: RefreshLog['type'],
    details?: string,
    serverName?: string,
    requestInfo?: string,
    errorReason?: string
  ) => void;
  clearLogs: () => void;
}

export function useFeedback({ t }: UseFeedbackOptions): UseFeedbackReturn {
  // Toast state management
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Refresh logs state
  const [refreshLogs, setRefreshLogs] = useState<RefreshLog[]>([]);

  // Toast helper functions
  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Log helper functions
  const addLog = useCallback((
    message: string,
    type: RefreshLog['type'] = 'info',
    details?: string,
    serverName?: string,
    requestInfo?: string,
    errorReason?: string
  ) => {
    const id = `log-${Date.now()}-${Math.random()}`;
    const log: RefreshLog = {
      id,
      timestamp: new Date(),
      type,
      message,
      details,
      serverName,
      requestInfo,
      errorReason
    };
    setRefreshLogs((prev) => [...prev, log].slice(-100));
  }, []);

  const clearLogs = useCallback(() => {
    setRefreshLogs([]);
    addLog(t('mcp.logs.cleared'), 'info');
  }, [addLog, t]);

  return { toasts, refreshLogs, addToast, dismissToast, addLog, clearLogs };
}
