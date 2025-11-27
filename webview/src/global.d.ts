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
    // 配置相关
    updateProviders?: (jsonStr: string) => void;
    updateActiveProvider?: (jsonStr: string) => void;
    showError?: (message: string) => void;
    updateUsageStatistics?: (jsonStr: string) => void;
    // 输入框补全相关 (004-refactor-input-box)
    onFileListResult?: (json: string) => void;
    onCommandListResult?: (json: string) => void;
    onUsageUpdate?: (json: string) => void;
    onModeChanged?: (mode: string) => void;
    onModelChanged?: (modelId: string) => void;
  }
}

export {};

