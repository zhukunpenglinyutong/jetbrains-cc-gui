import { useEffect, useMemo, useState } from 'react';
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
import UsageSection from './UsageSection';
import PlaceholderSection from './PlaceholderSection';
import CommunitySection from './CommunitySection';
import AgentSection from './AgentSection';
import { SkillsSettingsSection } from '../skills';

import styles from './style.module.less';

interface SettingsViewProps {
  onClose: () => void;
  initialTab?: SettingsTab;
  currentProvider: 'claude' | 'codex' | string;
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

const SettingsView = ({ onClose, initialTab, currentProvider }: SettingsViewProps) => {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  // Codex mode: allow providers tab, disable other features
  const disabledTabs = useMemo<SettingsTab[]>(
    () => (isCodexMode ? ['usage', 'mcp', 'permissions', 'agents', 'skills'] : []),
    [isCodexMode]
  );
  const [currentTab, setCurrentTab] = useState<SettingsTab>(() => {
    const initial = initialTab || 'basic';
    if (isCodexMode && disabledTabs.includes(initial)) {
      return 'basic';
    }
    return initial;
  });
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);

  // Codex provider state
  const [codexProviders, setCodexProviders] = useState<CodexProviderConfig[]>([]);
  const [codexLoading, setCodexLoading] = useState(false);
  // Reserved for future Codex config display (similar to Claude config info)
  const [_codexConfig, setCodexConfig] = useState<any>(null);
  const [_codexConfigLoading, setCodexConfigLoading] = useState(false);

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

  // 供应商弹窗状态
  const [providerDialog, setProviderDialog] = useState<{
    isOpen: boolean;
    provider: ProviderConfig | null; // null 表示添加模式
  }>({ isOpen: false, provider: null });

  // Codex 供应商弹窗状态
  const [codexProviderDialog, setCodexProviderDialog] = useState<{
    isOpen: boolean;
    provider: CodexProviderConfig | null;
  }>({ isOpen: false, provider: null });

  // Codex 供应商删除确认状态
  const [deleteCodexConfirm, setDeleteCodexConfirm] = useState<{
    isOpen: boolean;
    provider: CodexProviderConfig | null;
  }>({ isOpen: false, provider: null });

  // 页面内弹窗状态
  const [alertDialog, setAlertDialog] = useState<{
    isOpen: boolean;
    type: AlertType;
    title: string;
    message: string;
  }>({ isOpen: false, type: 'info', title: '', message: '' });

  // 确认删除弹窗状态
  const [deleteConfirm, setDeleteConfirm] = useState<{
    isOpen: boolean;
    provider: ProviderConfig | null;
  }>({ isOpen: false, provider: null });

  // Agent 智能体相关状态
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentDialog, setAgentDialog] = useState<{
    isOpen: boolean;
    agent: AgentConfig | null;
  }>({ isOpen: false, agent: null });
  const [deleteAgentConfirm, setDeleteAgentConfirm] = useState<{
    isOpen: boolean;
    agent: AgentConfig | null;
  }>({ isOpen: false, agent: null });

  // 主题状态
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    // 从 localStorage 读取主题设置
    const savedTheme = localStorage.getItem('theme');
    return (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
  });

  // 字体缩放状态 (1-6，默认为 3，即 100%)
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(() => {
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 3;
    return level >= 1 && level <= 6 ? level : 3;
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

  // Toast 状态管理
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const syncActiveProviderModelMapping = (provider?: ProviderConfig | null) => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!provider || !provider.settingsConfig || !provider.settingsConfig.env) {
      try {
        window.localStorage.removeItem('claude-model-mapping');
      } catch {
      }
      return;
    }
    const env = provider.settingsConfig.env as Record<string, any>;
    const mapping = {
      main: env.ANTHROPIC_MODEL ?? '',
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    };
    const hasValue = Object.values(mapping).some(v => v && String(v).trim().length > 0);
    try {
      if (hasValue) {
        window.localStorage.setItem('claude-model-mapping', JSON.stringify(mapping));
      } else {
        window.localStorage.removeItem('claude-model-mapping');
      }
    } catch {
    }
  };

  // Toast 辅助函数
  const addToast = (message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

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
    // 设置全局回调
    window.updateProviders = (jsonStr: string) => {
      try {
        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
        setProviders(providersList);
        const active = providersList.find(p => p.isActive);
        if (active) {
          syncActiveProviderModelMapping(active);
        }
        setLoading(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse providers:', error);
        setLoading(false);
      }
    };

    window.updateActiveProvider = (jsonStr: string) => {
      try {
        const activeProvider: ProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          // 更新列表中的激活状态
          setProviders((prev) =>
              prev.map((p) => ({ ...p, isActive: p.id === activeProvider.id }))
          );
          syncActiveProviderModelMapping(activeProvider);
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

    // Agent 智能体回调
    const previousUpdateAgents = window.updateAgents;
    window.updateAgents = (jsonStr: string) => {
      // 清除超时定时器（如果存在）
      const timeoutId = (window as any).__agentsLoadingTimeoutId;
      if (timeoutId) {
        clearTimeout(timeoutId);
        (window as any).__agentsLoadingTimeoutId = undefined;
      }

      try {
        const agentsList: AgentConfig[] = JSON.parse(jsonStr);
        setAgents(agentsList);
        setAgentsLoading(false);
        console.log('[SettingsView] Successfully loaded', agentsList.length, 'agents');
      } catch (error) {
        console.error('[SettingsView] Failed to parse agents:', error);
        setAgentsLoading(false);
      }

      previousUpdateAgents?.(jsonStr);
    };

    window.agentOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        if (result.success) {
          const operationMessages: Record<string, string> = {
            add: t('settings.agent.addSuccess'),
            update: t('settings.agent.updateSuccess'),
            delete: t('settings.agent.deleteSuccess'),
          };
          addToast(operationMessages[result.operation] || t('settings.agent.operationSuccess'), 'success');
        } else {
          addToast(result.error || t('settings.agent.operationFailed'), 'error');
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent operation result:', error);
      }
    };

    // Codex provider callbacks
    window.updateCodexProviders = (jsonStr: string) => {
      try {
        const providersList: CodexProviderConfig[] = JSON.parse(jsonStr);
        setCodexProviders(providersList);
        setCodexLoading(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex providers:', error);
        setCodexLoading(false);
      }
    };

    window.updateActiveCodexProvider = (jsonStr: string) => {
      try {
        const activeProvider: CodexProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          setCodexProviders((prev) =>
            prev.map((p) => ({ ...p, isActive: p.id === activeProvider.id }))
          );
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active Codex provider:', error);
      }
    };

    window.updateCurrentCodexConfig = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        setCodexConfig(config);
        setCodexConfigLoading(false);
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

    return () => {
      // 清理超时定时器
      const timeoutId = (window as any).__agentsLoadingTimeoutId;
      if (timeoutId) {
        clearTimeout(timeoutId);
        (window as any).__agentsLoadingTimeoutId = undefined;
      }

      window.updateProviders = undefined;
      window.updateActiveProvider = undefined;
      window.updateCurrentClaudeConfig = undefined;
      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateNodePath = undefined;
      window.updateWorkingDirectory = undefined;
      window.showSuccess = undefined;
      window.onEditorFontConfigReceived = undefined;
      window.updateAgents = previousUpdateAgents;
      window.agentOperationResult = undefined;
      // Cleanup Codex callbacks
      window.updateCodexProviders = undefined;
      window.updateActiveCodexProvider = undefined;
      window.updateCurrentCodexConfig = undefined;
    };
  }, [t]);

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

  // 主题切换处理
  useEffect(() => {
    // 应用主题到 document.documentElement
    document.documentElement.setAttribute('data-theme', theme);
    // 保存到 localStorage
    localStorage.setItem('theme', theme);
  }, [theme]);

  // 字体缩放处理
  useEffect(() => {
    // 将档位映射到缩放比例
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90%
      3: 1.0,   // 100% (默认)
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

  const loadProviders = () => {
    setLoading(true);
    sendToJava('get_providers:');
  };

  const loadCodexProviders = () => {
    setCodexLoading(true);
    sendToJava('get_codex_providers:');
  };

  const loadAgents = (retryCount = 0) => {
    const MAX_RETRIES = 2;
    const TIMEOUT = 3000; // 3秒超时

    setAgentsLoading(true);
    sendToJava('get_agents:');

    // 设置超时定时器
    const timeoutId = setTimeout(() => {
      console.warn('[SettingsView] loadAgents timeout, attempt:', retryCount + 1);

      if (retryCount < MAX_RETRIES) {
        // 重试
        loadAgents(retryCount + 1);
      } else {
        // 达到最大重试次数，停止加载
        console.error('[SettingsView] loadAgents failed after', MAX_RETRIES, 'retries');
        setAgentsLoading(false);
        setAgents([]); // 显示空列表，允许用户继续使用
      }
    }, TIMEOUT);

    // 将超时ID存储到window对象，以便回调时清除
    (window as any).__agentsLoadingTimeoutId = timeoutId;
  };

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

  const handleEditProvider = (provider: ProviderConfig) => {
    setProviderDialog({ isOpen: true, provider });
  };

  const handleAddProvider = () => {
    setProviderDialog({ isOpen: true, provider: null });
  };

  const handleCloseProviderDialog = () => {
    setProviderDialog({ isOpen: false, provider: null });
  };

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

    setProviderDialog({ isOpen: false, provider: null });
    setLoading(true);
  };

  const handleSwitchProvider = (id: string) => {
    const data = { id };
    const target = providers.find(p => p.id === id);
    if (target) {
      syncActiveProviderModelMapping(target);
    }
    sendToJava(`switch_provider:${JSON.stringify(data)}`);
    setLoading(true);
  };

  const handleDeleteProvider = (provider: ProviderConfig) => {
    console.log('[SettingsView] handleDeleteProvider called:', provider.id, provider.name);

    // 显示确认弹窗（无任何限制）
    setDeleteConfirm({ isOpen: true, provider });
  };

  const confirmDeleteProvider = () => {
    const provider = deleteConfirm.provider;
    if (!provider) return;

    console.log('[SettingsView] confirmDeleteProvider - sending delete_provider:', provider.id);
    const data = { id: provider.id };
    sendToJava(`delete_provider:${JSON.stringify(data)}`);
    addToast(t('toast.providerDeleted'), 'success');
    setLoading(true);
    setDeleteConfirm({ isOpen: false, provider: null });
  };

  const cancelDeleteProvider = () => {
    setDeleteConfirm({ isOpen: false, provider: null });
  };

  // ==================== Codex Provider 处理函数 ====================
  const handleAddCodexProvider = () => {
    setCodexProviderDialog({ isOpen: true, provider: null });
  };

  const handleEditCodexProvider = (provider: CodexProviderConfig) => {
    setCodexProviderDialog({ isOpen: true, provider });
  };

  const handleCloseCodexProviderDialog = () => {
    setCodexProviderDialog({ isOpen: false, provider: null });
  };

  const handleSaveCodexProviderFromDialog = (providerData: CodexProviderConfig) => {
    const isAdding = !codexProviderDialog.provider;

    if (isAdding) {
      sendToJava(`add_codex_provider:${JSON.stringify(providerData)}`);
      addToast(t('toast.providerAdded'), 'success');
    } else {
      const updateData = {
        id: providerData.id,
        updates: {
          name: providerData.name,
          remark: providerData.remark,
          configToml: providerData.configToml,
          authJson: providerData.authJson,
        },
      };
      sendToJava(`update_codex_provider:${JSON.stringify(updateData)}`);
      addToast(t('toast.providerUpdated'), 'success');
    }

    setCodexProviderDialog({ isOpen: false, provider: null });
    setCodexLoading(true);
  };

  const handleSwitchCodexProvider = (id: string) => {
    const data = { id };
    sendToJava(`switch_codex_provider:${JSON.stringify(data)}`);
    setCodexLoading(true);
  };

  const handleDeleteCodexProvider = (provider: CodexProviderConfig) => {
    setDeleteCodexConfirm({ isOpen: true, provider });
  };

  const confirmDeleteCodexProvider = () => {
    const provider = deleteCodexConfirm.provider;
    if (!provider) return;

    const data = { id: provider.id };
    sendToJava(`delete_codex_provider:${JSON.stringify(data)}`);
    addToast(t('toast.providerDeleted'), 'success');
    setCodexLoading(true);
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  };

  const cancelDeleteCodexProvider = () => {
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  };

  // ==================== Agent 智能体处理函数 ====================
  const handleAddAgent = () => {
    setAgentDialog({ isOpen: true, agent: null });
  };

  const handleEditAgent = (agent: AgentConfig) => {
    setAgentDialog({ isOpen: true, agent });
  };

  const handleDeleteAgent = (agent: AgentConfig) => {
    setDeleteAgentConfirm({ isOpen: true, agent });
  };

  const handleCloseAgentDialog = () => {
    setAgentDialog({ isOpen: false, agent: null });
  };

  const handleSaveAgentFromDialog = (data: { name: string; prompt: string }) => {
    const isAdding = !agentDialog.agent;

    if (isAdding) {
      // 添加新智能体
      const newAgent = {
        id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
        name: data.name,
        prompt: data.prompt,
      };
      sendToJava(`add_agent:${JSON.stringify(newAgent)}`);
    } else if (agentDialog.agent) {
      // 更新现有智能体
      const updateData = {
        id: agentDialog.agent.id,
        updates: {
          name: data.name,
          prompt: data.prompt,
        },
      };
      sendToJava(`update_agent:${JSON.stringify(updateData)}`);
    }

    setAgentDialog({ isOpen: false, agent: null });
    // 智能体操作后重新加载列表（包含超时保护）
    loadAgents();
  };

  const confirmDeleteAgent = () => {
    const agent = deleteAgentConfirm.agent;
    if (!agent) return;

    const data = { id: agent.id };
    sendToJava(`delete_agent:${JSON.stringify(data)}`);
    setDeleteAgentConfirm({ isOpen: false, agent: null });
    // 删除后重新加载列表（包含超时保护）
    loadAgents();
  };

  const cancelDeleteAgent = () => {
    setDeleteAgentConfirm({ isOpen: false, agent: null });
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
          {currentTab === 'basic' && (
            <BasicConfigSection
              theme={theme}
              onThemeChange={setTheme}
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
            />
          )}

          {/* 供应商管理 */}
          {currentTab === 'providers' && !isCodexMode && (
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
          )}

          {/* Codex 供应商管理 */}
          {currentTab === 'providers' && isCodexMode && (
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
          )}

          {/* 使用统计 */}
          {currentTab === 'usage' && <UsageSection />}

          {/* MCP服务器 */}
          {currentTab === 'mcp' && <PlaceholderSection type="mcp" />}

          {/* 权限配置 */}
          {currentTab === 'permissions' && <PlaceholderSection type="permissions" />}

          {/* Agents */}
          {currentTab === 'agents' && (
            <AgentSection
              agents={agents}
              loading={agentsLoading}
              onAdd={handleAddAgent}
              onEdit={handleEditAgent}
              onDelete={handleDeleteAgent}
            />
          )}

          {/* Skills */}
          {currentTab === 'skills' && <SkillsSettingsSection />}

          {/* 官方交流群 */}
          {currentTab === 'community' && <CommunitySection />}
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
