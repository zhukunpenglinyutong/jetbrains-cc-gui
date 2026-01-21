import { useState, useCallback } from 'react';
import type { ToastMessage } from '../components/Toast';

const DEFAULT_STATUS = 'ready';

interface UseToastManagementReturn {
  toasts: ToastMessage[];
  addToast: (message: string, type?: ToastMessage['type']) => void;
  dismissToast: (id: string) => void;
}

/**
 * Hook for managing toast notifications
 * Extracts toast state and functions from App.tsx
 */
export function useToastManagement(): UseToastManagementReturn {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    // Don't show toast for default status
    if (message === DEFAULT_STATUS || !message) return;

    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return {
    toasts,
    addToast,
    dismissToast,
  };
}
