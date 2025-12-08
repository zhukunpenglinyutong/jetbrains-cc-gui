import type { HistoryData } from './types';

declare global {
  interface Window {
    sendToJava?: (payload: string) => void;
    updateMessages?: (json: string) => void;
    updateStatus?: (status: string) => void;
    showLoading?: (show: boolean | string) => void;
    showThinkingStatus?: (show: boolean | string) => void;
    setHistoryData?: (data: HistoryData) => void;
    clearMessages?: () => void;
    addErrorMessage?: (message: string) => void;
    // 配置相关
    updateProviders?: (jsonStr: string) => void;
    updateActiveProvider?: (jsonStr: string) => void;
    updateCurrentClaudeConfig?: (jsonStr: string) => void;
    showError?: (message: string) => void;
    showSwitchSuccess?: (message: string) => void;
	  updateNodePath?: (path: string) => void;
    updateUsageStatistics?: (jsonStr: string) => void;
    // 输入框补全相关 (004-refactor-input-box)
    onFileListResult?: (json: string) => void;
    onCommandListResult?: (json: string) => void;
    onUsageUpdate?: (json: string) => void;
    onModeChanged?: (mode: string) => void;
    onModelChanged?: (modelId: string) => void;
    // 权限弹窗相关
    showPermissionDialog?: (json: string) => void;
    // MCP 服务器相关
    updateMcpServers?: (jsonStr: string) => void;
    mcpServerAdded?: (jsonStr: string) => void;
    mcpServerUpdated?: (jsonStr: string) => void;
    mcpServerDeleted?: (serverId: string) => void;
    mcpServerValidated?: (jsonStr: string) => void;
    // Skills 相关
    updateSkills?: (jsonStr: string) => void;
    skillImportResult?: (jsonStr: string) => void;
    skillDeleteResult?: (jsonStr: string) => void;
    skillToggleResult?: (jsonStr: string) => void;
    // 选中代码发送到终端相关
    addSelectionInfo?: (selectionInfo: string) => void;
  }
}

export {};
