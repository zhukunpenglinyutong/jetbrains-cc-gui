import type { HistoryData } from './types';

declare global {
  interface Window {
    sendToJava?: (payload: string) => void;
    updateMessages?: (json: string) => void;
    updateStatus?: (status: string) => void;
    showLoading?: (show: boolean | string) => void;
    setHistoryData?: (data: HistoryData) => void;
    clearMessages?: () => void;
    addErrorMessage?: (message: string) => void;
  }
}

export {};

