import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, CodexProviderConfig } from '../../types/provider';
import type { AgentConfig } from '../../types/agent';
import { type ClaudeConfig } from './ConfigInfoDisplay';
import AlertDialog from '../AlertDialog';
import type { AlertType } from '../AlertDialog';
import ConfirmDialog from '../ConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import ProviderDialog from '../ProviderDialog';
import CodexProviderDialog from '../CodexProviderDialog';
import AgentDialog from '../AgentDialog';

// 导入拆分后的组件
import SettingsHeader from './SettingsHeader';
import SettingsSidebar, { type SettingsTab } from './SettingsSidebar';
import BasicConfigSection from './BasicConfigSection';
import ProviderManageSection from './ProviderManageSection';
import DependencySection from './DependencySection';
import UsageSection from './UsageSection';
import PlaceholderSection from './PlaceholderSection';
import CommunitySection from './CommunitySection';
import AgentSection from './AgentSection';
import CommitSection from './CommitSection';
import OtherSettingsSection from './OtherSettingsSection';
import { SkillsSettingsSection } from '../skills';

// 导入自定义 hooks
import {
  useProviderManagement,
  useCodexProviderManagement,
  useAgentManagement,
} from './hooks';

import styles from './style.module.less';

interface SettingsViewProps {
  onClose: () => void;
  initialTab?: SettingsTab;
  currentProvider: 'claude' | 'codex' | string;
  // Streaming configuration (passed from App.tsx for state sync)
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  // Send shortcut configuration (passed from App.tsx for state sync)
  sendShortcut?: 'enter' | 'cmdEnter';
  onSendShortcutChange?: (shortcut: 'enter' | 'cmdEnter') => void;
}

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  } else {
    console.warn('[SettingsView] sendToJava is not available');
  }
};

// 自动折叠阈值（窗口宽度）
const AUTO_COLLAPSE_THRESHOLD = 900;

const SettingsView = ({ onClose, initialTab, currentProvider, streamingEnabled: streamingEnabledProp, onStreamingEnabledChange: onStreamingEnabledChangeProp, sendShortcut: sendShortcutProp, onSendShortcutChange: onSendShortcutChangeProp }: SettingsViewProps) => {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  // Codex mode: allow providers, usage, and mcp tabs, disable other features
  // Note: 'mcp' is now enabled for Codex as it supports MCP via ~/.codex/config.toml
  const disabledTabs = useMemo<SettingsTab[]>(
    () => (isCodexMode ? ['permissions', 'agents', 'skills'] : []),
    [isCodexMode]
  );
  const [currentTab, setCurrentTab] = useState<SettingsTab>(() => {
    const initial = initialTab || 'basic';
    if (isCodexMode && disabledTabs.includes(initial)) {
      return 'basic';
    }
    return initial;
  });

  // Toast 状态管理
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast 辅助函数
  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // 使用 Provider 管理 hook
  const {
    providers,
    loading,
    providerDialog,
    deleteConfirm,
    loadProviders,
    updateProviders,
    updateActiveProvider,
    handleEditProvider,
    handleAddProvider,
    handleCloseProviderDialog,
    handleSwitchProvider,
    handleDeleteProvider,
    confirmDeleteProvider,
    cancelDeleteProvider,
    syncActiveProviderModelMapping,
    setLoading,
  } = useProviderManagement({
    onError: (msg) => showAlert('error', t('common.error'), msg),
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // 使用 Codex Provider 管理 hook
  const {
    codexProviders,
    codexLoading,
    codexProviderDialog,
    deleteCodexConfirm,
    loadCodexProviders,
    updateCodexProviders,
    updateActiveCodexProvider,
    updateCurrentCodexConfig,
    handleAddCodexProvider,
    handleEditCodexProvider,
    handleCloseCodexProviderDialog,
    handleSaveCodexProvider,
    handleSwitchCodexProvider,
    handleDeleteCodexProvider,
    confirmDeleteCodexProvider,
    cancelDeleteCodexProvider,
    setCodexLoading,
    setCodexConfigLoading,
  } = useCodexProviderManagement({
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // 使用 Agent 管理 hook
  const {
    agents,
    agentsLoading,
    agentDialog,
    deleteAgentConfirm,
    loadAgents,
    updateAgents,
    cleanupAgentsTimeout,
    handleAddAgent,
    handleEditAgent,
    handleCloseAgentDialog,
    handleDeleteAgent,
    handleSaveAgent,
    confirmDeleteAgent,
    cancelDeleteAgent,
    handleAgentOperationResult,
  } = useAgentManagement({
    onSuccess: (msg) => addToast(msg, 'success'),
  });

  // Claude CLI 当前配置（来自 ~/.claude/settings.json）
  const [claudeConfig, setClaudeConfig] = useState<ClaudeConfig | null>(null);
  const [claudeConfigLoading, setClaudeConfigLoading] = useState(false);

  // 侧边栏响应式状态
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);

  // 计算是否应该折叠：优先使用手动设置，否则根据窗口宽度自动判断
  const isCollapsed = manualCollapsed !== null
      ? manualCollapsed
      : windowWidth < AUTO_COLLAPSE_THRESHOLD;

  // 页面内弹窗状态
  const [alertDialog, setAlertDialog] = useState<{
    isOpen: boolean;
    type: AlertType;
    title: string;
    message: string;
  }>({ isOpen: false, type: 'info', title: '', message: '' });

  // 主题状态
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>(() => {
    // 从 localStorage 读取主题设置
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      return savedTheme;
    }
    return 'system'; // 默认跟随 IDE
  });

  // IDE 主题状态（优先使用 Java 注入的初始主题，用于处理动态变化）
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // 检查 Java 是否注入了初始主题
    const injectedTheme = (window as any).__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // 字体缩放状态 (1-6，默认为 2，即 90%)
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(() => {
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 2;
    return level >= 1 && level <= 6 ? level : 2;
  });

  // Node.js 路径（手动指定时使用）
  const [nodePath, setNodePath] = useState('');
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [minNodeVersion, setMinNodeVersion] = useState(18);
  const [savingNodePath, setSavingNodePath] = useState(false);

  // 工作目录配置
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [savingWorkingDirectory, setSavingWorkingDirectory] = useState(false);

  // IDEA 编辑器字体配置（只读展示）
  const [editorFontConfig, setEditorFontConfig] = useState<{
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  } | undefined>();

  // 🔧 流式传输配置 - 优先使用 props，否则使用本地状态（兼容未传递 props 的场景）
  const [localStreamingEnabled, setLocalStreamingEnabled] = useState<boolean>(false);
  const streamingEnabled = streamingEnabledProp ?? localStreamingEnabled;

  // 发送快捷键配置 - 优先使用 props，否则使用本地状态
  const [localSendShortcut, setLocalSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  const sendShortcut = sendShortcutProp ?? localSendShortcut;

  // Commit AI 提示词配置
  const [commitPrompt, setCommitPrompt] = useState('');
  const [savingCommitPrompt, setSavingCommitPrompt] = useState(false);

  // 历史补全开关配置
  const [historyCompletionEnabled, setHistoryCompletionEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('historyCompletionEnabled');
    return saved !== 'false'; // 默认开启
  });

  const handleTabChange = (tab: SettingsTab) => {
    if (isCodexMode && disabledTabs.includes(tab)) {
      addToast(t('settings.codexFeatureUnavailable'), 'warning');
      return;
    }
    setCurrentTab(tab);
  };

  // 显示页面内弹窗的帮助函数
  const showAlert = (type: AlertType, title: string, message: string) => {
    console.log('[SettingsView] showAlert called:', { type, title, message });
    setAlertDialog({ isOpen: true, type, title, message });
  };

  const closeAlert = () => {
    setAlertDialog({ ...alertDialog, isOpen: false });
  };

  // 显示切换成功弹窗
  const showSwitchSuccess = (message: string) => {
    console.log('[SettingsView] showSwitchSuccess called:', message);
    showAlert('success', t('toast.switchSuccess'), message);
  };

  useEffect(() => {
    // 设置全局回调 - 使用 hooks 提供的更新函数
    window.updateProviders = (jsonStr: string) => {
      try {
        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
        updateProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse providers:', error);
        setLoading(false);
      }
    };

    window.updateActiveProvider = (jsonStr: string) => {
      try {
        const activeProvider: ProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          updateActiveProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active provider:', error);
      }
    };

    // Claude CLI 配置回调
    window.updateCurrentClaudeConfig = (jsonStr: string) => {
      try {
        const config: ClaudeConfig = JSON.parse(jsonStr);
        setClaudeConfig(config);
        setClaudeConfigLoading(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse claude config:', error);
        setClaudeConfigLoading(false);
      }
    };

    window.showError = (message: string) => {
      console.log('[SettingsView] window.showError called:', message);
      showAlert('error', t('toast.operationFailed'), message);
      setLoading(false);
      setSavingNodePath(false);
      setSavingWorkingDirectory(false);
      setSavingCommitPrompt(false);
    };

    window.showSwitchSuccess = (message: string) => {
      console.log('[SettingsView] window.showSwitchSuccess called:', message);
      showSwitchSuccess(message);
    };

    window.updateNodePath = (jsonStr: string) => {
      console.log('[SettingsView] window.updateNodePath called:', jsonStr);
      try {
        const data = JSON.parse(jsonStr);
        setNodePath(data.path || '');
        setNodeVersion(data.version || null);
        if (data.minVersion) {
          setMinNodeVersion(data.minVersion);
        }
      } catch (e) {
        // 兼容旧格式（纯字符串路径）
        console.warn('[SettingsView] Failed to parse updateNodePath JSON, fallback to legacy format:', e);
        setNodePath(jsonStr || '');
      }
      setSavingNodePath(false);
    };

    window.updateWorkingDirectory = (jsonStr: string) => {
      console.log('[SettingsView] window.updateWorkingDirectory called:', jsonStr);
      try {
        const data = JSON.parse(jsonStr);
        setWorkingDirectory(data.customWorkingDir || '');
        setSavingWorkingDirectory(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse working directory:', error);
        setSavingWorkingDirectory(false);
      }
    };

    window.showSuccess = (message: string) => {
      console.log('[SettingsView] window.showSuccess called:', message);
      showAlert('success', t('toast.operationSuccess'), message);
      setSavingNodePath(false);
      setSavingWorkingDirectory(false);
    };

    window.onEditorFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        setEditorFontConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse editor font config:', error);
      }
    };

    // IDE 主题回调 - 保存之前的回调以便恢复
    const previousOnIdeThemeReceived = window.onIdeThemeReceived;
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        setIdeTheme(theme);
        console.log('[SettingsView] IDE theme received:', themeData, 'resolved to:', theme);
        // 同时调用之前的回调（App.tsx 的回调）
        previousOnIdeThemeReceived?.(jsonStr);
      } catch (error) {
        console.error('[SettingsView] Failed to parse IDE theme:', error);
      }
    };

    // 🔧 流式传输配置回调 - 仅在未从 App.tsx 传递 props 时使用本地状态
    const previousUpdateStreamingEnabled = window.updateStreamingEnabled;
    if (!onStreamingEnabledChangeProp) {
      window.updateStreamingEnabled = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          setLocalStreamingEnabled(data.streamingEnabled ?? true);
        } catch (error) {
          console.error('[SettingsView] Failed to parse streaming config:', error);
        }
      };
    }

    // 发送快捷键配置回调 - 仅在未从 App.tsx 传递 props 时使用本地状态
    const previousUpdateSendShortcut = window.updateSendShortcut;
    if (!onSendShortcutChangeProp) {
      window.updateSendShortcut = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          setLocalSendShortcut(data.sendShortcut ?? 'enter');
        } catch (error) {
          console.error('[SettingsView] Failed to parse send shortcut config:', error);
        }
      };
    }

    // Commit AI 提示词回调
    window.updateCommitPrompt = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setCommitPrompt(data.commitPrompt || '');
        setSavingCommitPrompt(false);
        // 如果是保存操作，显示成功提示
        if (data.saved) {
          addToast(t('toast.saveSuccess'), 'success');
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse commit prompt:', error);
        setSavingCommitPrompt(false);
        addToast(t('toast.saveFailed'), 'error');
      }
    };

    // Agent 智能体回调 - 使用 hooks 提供的更新函数
    const previousUpdateAgents = window.updateAgents;
    window.updateAgents = (jsonStr: string) => {
      try {
        const agentsList: AgentConfig[] = JSON.parse(jsonStr);
        updateAgents(agentsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agents:', error);
      }
      previousUpdateAgents?.(jsonStr);
    };

    window.agentOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        handleAgentOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent operation result:', error);
      }
    };

    // Codex provider callbacks - 使用 hooks 提供的更新函数
    window.updateCodexProviders = (jsonStr: string) => {
      try {
        const providersList: CodexProviderConfig[] = JSON.parse(jsonStr);
        updateCodexProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex providers:', error);
        setCodexLoading(false);
      }
    };

    window.updateActiveCodexProvider = (jsonStr: string) => {
      try {
        const activeProvider: CodexProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          updateActiveCodexProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active Codex provider:', error);
      }
    };

    window.updateCurrentCodexConfig = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        updateCurrentCodexConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex config:', error);
        setCodexConfigLoading(false);
      }
    };

    // 加载供应商列表
    loadProviders();
    // 加载 Codex 供应商列表
    loadCodexProviders();
    // 加载智能体列表
    loadAgents();
    // 加载 Claude CLI 当前配置
    loadClaudeConfig();
    // 加载 Node.js 路径
    sendToJava('get_node_path:');
    // 加载工作目录配置
    sendToJava('get_working_directory:');
    // 加载 IDEA 编辑器字体配置
    sendToJava('get_editor_font_config:');
    // 🔧 加载流式传输配置
    sendToJava('get_streaming_enabled:');
    // 加载 Commit AI 提示词
    sendToJava('get_commit_prompt:');

    return () => {
      // 清理 Agent 超时定时器 - 使用 hook 提供的清理函数
      cleanupAgentsTimeout();

      window.updateProviders = undefined;
      window.updateActiveProvider = undefined;
      window.updateCurrentClaudeConfig = undefined;
      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateNodePath = undefined;
      window.updateWorkingDirectory = undefined;
      window.showSuccess = undefined;
      window.onEditorFontConfigReceived = undefined;
      // 恢复之前的 IDE 主题回调（App.tsx 的回调）
      window.onIdeThemeReceived = previousOnIdeThemeReceived;
      // Restore previous streaming callback if we overrode it
      if (!onStreamingEnabledChangeProp) {
        window.updateStreamingEnabled = previousUpdateStreamingEnabled;
      }
      // Restore previous send shortcut callback if we overrode it
      if (!onSendShortcutChangeProp) {
        window.updateSendShortcut = previousUpdateSendShortcut;
      }
      window.updateCommitPrompt = undefined;
      window.updateAgents = previousUpdateAgents;
      window.agentOperationResult = undefined;
      // Cleanup Codex callbacks
      window.updateCodexProviders = undefined;
      window.updateActiveCodexProvider = undefined;
      window.updateCurrentCodexConfig = undefined;
    };

    // 请求 IDE 主题信息
    sendToJava('get_ide_theme:');
  }, [t, onStreamingEnabledChangeProp, onSendShortcutChangeProp]);

  // 监听窗口大小变化
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);

      // 如果窗口大小变化导致应该自动切换状态，重置手动设置
      const shouldAutoCollapse = window.innerWidth < AUTO_COLLAPSE_THRESHOLD;
      if (manualCollapsed !== null && manualCollapsed === shouldAutoCollapse) {
        setManualCollapsed(null);
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [manualCollapsed]);

  // 手动切换侧边栏折叠状态
  const toggleManualCollapse = () => {
    if (manualCollapsed === null) {
      // 如果当前是自动模式，切换到手动模式
      setManualCollapsed(!isCollapsed);
    } else {
      // 如果已经是手动模式，切换状态
      setManualCollapsed(!manualCollapsed);
    }
  };

  // 主题切换处理（支持跟随 IDE）
  useEffect(() => {
    const applyTheme = (preference: 'light' | 'dark' | 'system') => {
      if (preference === 'system') {
        // 如果是跟随 IDE，需要等待 IDE 主题加载完成
        if (ideTheme === null) {
          console.log('[SettingsView] Waiting for IDE theme to load...');
          return; // 等待 ideTheme 加载
        }
        document.documentElement.setAttribute('data-theme', ideTheme);
      } else {
        // 明确的 light/dark 选择，立即应用
        document.documentElement.setAttribute('data-theme', preference);
      }
    };

    applyTheme(themePreference);
    // 保存到 localStorage
    localStorage.setItem('theme', themePreference);
  }, [themePreference, ideTheme]);

  // 字体缩放处理
  useEffect(() => {
    // 将档位映射到缩放比例
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90% (默认)
      3: 1.0,   // 100%
      4: 1.1,   // 110%
      5: 1.2,   // 120%
      6: 1.4,   // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;

    // 应用到根元素
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // 保存到 localStorage
    localStorage.setItem('fontSizeLevel', fontSizeLevel.toString());
  }, [fontSizeLevel]);

  useEffect(() => {
    if (isCodexMode && disabledTabs.includes(currentTab)) {
      setCurrentTab('basic');
    }
  }, [isCodexMode, disabledTabs, currentTab]);

  const loadClaudeConfig = () => {
    setClaudeConfigLoading(true);
    sendToJava('get_current_claude_config:');
  };

  const handleSaveNodePath = () => {
    setSavingNodePath(true);
    const payload = { path: (nodePath || '').trim() };
    sendToJava(`set_node_path:${JSON.stringify(payload)}`);
  };

  const handleSaveWorkingDirectory = () => {
    setSavingWorkingDirectory(true);
    const payload = { customWorkingDir: (workingDirectory || '').trim() };
    sendToJava(`set_working_directory:${JSON.stringify(payload)}`);
  };

  // 🔧 流式传输开关变更处理
  const handleStreamingEnabledChange = (enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onStreamingEnabledChangeProp) {
      onStreamingEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalStreamingEnabled(enabled);
      const payload = { streamingEnabled: enabled };
      sendToJava(`set_streaming_enabled:${JSON.stringify(payload)}`);
    }
  };

  // 发送快捷键变更处理
  const handleSendShortcutChange = (shortcut: 'enter' | 'cmdEnter') => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onSendShortcutChangeProp) {
      onSendShortcutChangeProp(shortcut);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalSendShortcut(shortcut);
      const payload = { sendShortcut: shortcut };
      sendToJava(`set_send_shortcut:${JSON.stringify(payload)}`);
    }
  };

  // Commit AI 提示词保存处理
  const handleSaveCommitPrompt = () => {
    setSavingCommitPrompt(true);
    const payload = { prompt: commitPrompt };
    sendToJava(`set_commit_prompt:${JSON.stringify(payload)}`);
  };

  // 保存供应商（带验证逻辑的包装函数）
  const handleSaveProviderFromDialog = (data: {
    providerName: string;
    remark: string;
    apiKey: string;
    apiUrl: string;
    jsonConfig: string;
  }) => {
    if (!data.providerName) {
      showAlert('warning', t('common.warning'), t('toast.pleaseEnterProviderName'));
      return;
    }

    // 解析 JSON 配置
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(data.jsonConfig || '{}');
    } catch (e) {
      showAlert('error', t('common.error'), t('toast.invalidJsonConfig'));
      return;
    }

    const updates = {
      name: data.providerName,
      remark: data.remark,
      websiteUrl: null, // 清除可能存在的旧字段，避免显示混淆
      settingsConfig: parsedConfig,
    };

    const isAdding = !providerDialog.provider;

    if (isAdding) {
      // 添加新供应商
      const newProvider = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
        ...updates
      };
      sendToJava(`add_provider:${JSON.stringify(newProvider)}`);
      addToast(t('toast.providerAdded'), 'success');
    } else {
      // 更新现有供应商
      if (!providerDialog.provider) return;

      const providerId = providerDialog.provider.id;
      // 检查当前编辑的供应商是否是激活状态
      // 优先从 providers 列表中查找最新状态，如果找不到则使用 dialog 中的状态
      const currentProvider = providers.find(p => p.id === providerId) || providerDialog.provider;
      const isActive = currentProvider.isActive;

      const updateData = {
        id: providerId,
        updates,
      };
      sendToJava(`update_provider:${JSON.stringify(updateData)}`);
      addToast(t('toast.providerUpdated'), 'success');

      // 如果是当前正在使用的供应商，更新后立即重新应用配置
      if (isActive) {
        console.log('[SettingsView] Re-applying active provider config:', providerId);
        syncActiveProviderModelMapping({
          ...currentProvider,
          settingsConfig: parsedConfig,
        });
        // 使用 setTimeout 稍微延迟一下，确保 update_provider 先处理完成
        // 虽然在单线程模型中通常不需要，但为了保险起见
        setTimeout(() => {
          sendToJava(`switch_provider:${JSON.stringify({ id: providerId })}`);
        }, 100);
      }
    }

    handleCloseProviderDialog();
    setLoading(true);
  };

  // 保存 Codex 供应商（带验证逻辑的包装函数）
  const handleSaveCodexProviderFromDialog = (providerData: CodexProviderConfig) => {
    handleSaveCodexProvider(providerData);
  };

  // 保存智能体（带验证逻辑的包装函数）
  const handleSaveAgentFromDialog = (data: { name: string; prompt: string }) => {
    handleSaveAgent(data);
  };

  return (
    <div className={styles.settingsPage}>
      {/* 顶部标题栏 */}
      <SettingsHeader onClose={onClose} />

      {/* 主体内容 */}
      <div className={styles.settingsMain}>
        {/* 侧边栏 */}
        <SettingsSidebar
          currentTab={currentTab}
          onTabChange={handleTabChange}
          isCollapsed={isCollapsed}
          onToggleCollapse={toggleManualCollapse}
          disabledTabs={disabledTabs}
          onDisabledTabClick={() => addToast(t('settings.codexFeatureUnavailable'), 'warning')}
        />

        {/* 内容区域 */}
        <div className={`${styles.settingsContent} ${currentTab === 'providers' ? styles.providerSettingsContent : ''}`}>
          {/* 基础配置 */}
          <div style={{ display: currentTab === 'basic' ? 'block' : 'none' }}>
            <BasicConfigSection
              theme={themePreference}
              onThemeChange={setThemePreference}
              fontSizeLevel={fontSizeLevel}
              onFontSizeLevelChange={setFontSizeLevel}
              nodePath={nodePath}
              onNodePathChange={setNodePath}
              onSaveNodePath={handleSaveNodePath}
              savingNodePath={savingNodePath}
              nodeVersion={nodeVersion}
              minNodeVersion={minNodeVersion}
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={setWorkingDirectory}
              onSaveWorkingDirectory={handleSaveWorkingDirectory}
              savingWorkingDirectory={savingWorkingDirectory}
              editorFontConfig={editorFontConfig}
              streamingEnabled={streamingEnabled}
              onStreamingEnabledChange={handleStreamingEnabledChange}
              sendShortcut={sendShortcut}
              onSendShortcutChange={handleSendShortcutChange}
            />
          </div>

          {/* 供应商管理 */}
          <div style={{ display: currentTab === 'providers' && !isCodexMode ? 'block' : 'none' }}>
            <ProviderManageSection
              claudeConfig={claudeConfig}
              claudeConfigLoading={claudeConfigLoading}
              providers={providers}
              loading={loading}
              onAddProvider={handleAddProvider}
              onEditProvider={handleEditProvider}
              onDeleteProvider={handleDeleteProvider}
              onSwitchProvider={handleSwitchProvider}
              addToast={addToast}
            />
          </div>

          {/* Codex 供应商管理 */}
          <div style={{ display: currentTab === 'providers' && isCodexMode ? 'block' : 'none' }}>
            <div className={styles.configSection}>
              <h3 className={styles.sectionTitle}>{t('settings.codexProvider.title')}</h3>
              <p className={styles.sectionDesc}>{t('settings.codexProvider.description')}</p>

              {codexLoading && (
                <div className={styles.tempNotice}>
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                  <p>{t('settings.provider.loading')}</p>
                </div>
              )}

              {!codexLoading && (
                <div className={styles.providerListContainer}>
                  <div className={styles.providerListHeader}>
                    <h4>{t('settings.provider.allProviders')}</h4>
                    <button className="btn btn-primary" onClick={handleAddCodexProvider}>
                      <span className="codicon codicon-add" />
                      {t('common.add')}
                    </button>
                  </div>

                  <div className={styles.providerList}>
                    {codexProviders.length > 0 ? (
                      codexProviders.map((provider) => (
                        <div
                          key={provider.id}
                          className={`${styles.providerCard} ${provider.isActive ? styles.active : ''}`}
                        >
                          <div className={styles.providerInfo}>
                            <div className={styles.providerName}>{provider.name}</div>
                            {provider.remark && (
                              <div className={styles.providerRemark}>{provider.remark}</div>
                            )}
                          </div>

                          <div className={styles.providerActions}>
                            {provider.isActive ? (
                              <div className={styles.activeBadge}>
                                <span className="codicon codicon-check" />
                                {t('settings.provider.inUse')}
                              </div>
                            ) : (
                              <button
                                className={styles.useButton}
                                onClick={() => handleSwitchCodexProvider(provider.id)}
                              >
                                <span className="codicon codicon-play" />
                                {t('settings.provider.enable')}
                              </button>
                            )}

                            <div className={styles.actionButtons}>
                              <button
                                className={styles.iconBtn}
                                onClick={() => handleEditCodexProvider(provider)}
                                title={t('common.edit')}
                              >
                                <span className="codicon codicon-edit" />
                              </button>
                              <button
                                className={styles.iconBtn}
                                onClick={() => handleDeleteCodexProvider(provider)}
                                title={t('common.delete')}
                              >
                                <span className="codicon codicon-trash" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className={styles.emptyState}>
                        <span className="codicon codicon-info" />
                        <p>{t('settings.codexProvider.emptyProvider')}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* SDK 依赖管理 */}
          <div style={{ display: currentTab === 'dependencies' ? 'block' : 'none' }}>
            <DependencySection addToast={addToast} />
          </div>

          {/* 使用统计 */}
          <div style={{ display: currentTab === 'usage' ? 'block' : 'none' }}>
            <UsageSection currentProvider={currentProvider} />
          </div>

          {/* MCP服务器 */}
          <div style={{ display: currentTab === 'mcp' ? 'block' : 'none' }}>
            <PlaceholderSection type="mcp" currentProvider={currentProvider} />
          </div>

          {/* 权限配置 */}
          <div style={{ display: currentTab === 'permissions' ? 'block' : 'none' }}>
            <PlaceholderSection type="permissions" />
          </div>

          {/* Commit AI 配置 */}
          <div style={{ display: currentTab === 'commit' ? 'block' : 'none' }}>
            <CommitSection
              commitPrompt={commitPrompt}
              onCommitPromptChange={setCommitPrompt}
              onSaveCommitPrompt={handleSaveCommitPrompt}
              savingCommitPrompt={savingCommitPrompt}
            />
          </div>

          {/* Agents */}
          <div style={{ display: currentTab === 'agents' ? 'block' : 'none' }}>
            <AgentSection
              agents={agents}
              loading={agentsLoading}
              onAdd={handleAddAgent}
              onEdit={handleEditAgent}
              onDelete={handleDeleteAgent}
            />
          </div>

          {/* Skills */}
          <div style={{ display: currentTab === 'skills' ? 'block' : 'none' }}>
            <SkillsSettingsSection />
          </div>

          {/* 其他设置 */}
          <div style={{ display: currentTab === 'other' ? 'block' : 'none' }}>
            <OtherSettingsSection
              historyCompletionEnabled={historyCompletionEnabled}
              onHistoryCompletionEnabledChange={(enabled) => {
                setHistoryCompletionEnabled(enabled);
                localStorage.setItem('historyCompletionEnabled', enabled.toString());
                // Dispatch custom event for same-tab sync (localStorage 'storage' event only fires for cross-tab)
                window.dispatchEvent(new CustomEvent('historyCompletionChanged', { detail: { enabled } }));
              }}
            />
          </div>

          {/* 官方交流群 */}
          <div style={{ display: currentTab === 'community' ? 'block' : 'none' }}>
            <CommunitySection />
          </div>
        </div>
      </div>

      {/* 页面内弹窗 */}
      <AlertDialog
        isOpen={alertDialog.isOpen}
        type={alertDialog.type}
        title={alertDialog.title}
        message={alertDialog.message}
        onClose={closeAlert}
      />

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title={t('settings.provider.deleteConfirm')}
        message={t('settings.provider.deleteProviderMessage', { name: deleteConfirm.provider?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeleteProvider}
        onCancel={cancelDeleteProvider}
      />

      {/* 供应商添加/编辑弹窗 */}
      <ProviderDialog
        isOpen={providerDialog.isOpen}
        provider={providerDialog.provider}
        onClose={handleCloseProviderDialog}
        onSave={handleSaveProviderFromDialog}
        onDelete={handleDeleteProvider}
        canDelete={true}
        addToast={addToast}
      />

      {/* 智能体添加/编辑弹窗 */}
      <AgentDialog
        isOpen={agentDialog.isOpen}
        agent={agentDialog.agent}
        onClose={handleCloseAgentDialog}
        onSave={handleSaveAgentFromDialog}
      />

      {/* 智能体删除确认弹窗 */}
      <ConfirmDialog
        isOpen={deleteAgentConfirm.isOpen}
        title={t('settings.agent.deleteConfirmTitle')}
        message={t('settings.agent.deleteConfirmMessage', { name: deleteAgentConfirm.agent?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeleteAgent}
        onCancel={cancelDeleteAgent}
      />

      {/* Codex 供应商添加/编辑弹窗 */}
      <CodexProviderDialog
        isOpen={codexProviderDialog.isOpen}
        provider={codexProviderDialog.provider}
        onClose={handleCloseCodexProviderDialog}
        onSave={handleSaveCodexProviderFromDialog}
        addToast={addToast}
      />

      {/* Codex 供应商删除确认弹窗 */}
      <ConfirmDialog
        isOpen={deleteCodexConfirm.isOpen}
        title={t('settings.codexProvider.deleteConfirmTitle')}
        message={t('settings.codexProvider.deleteConfirmMessage', { name: deleteCodexConfirm.provider?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeleteCodexProvider}
        onCancel={cancelDeleteCodexProvider}
      />

      {/* Toast 通知 */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export default SettingsView;
