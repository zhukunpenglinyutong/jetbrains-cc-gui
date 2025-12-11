import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../../types/provider';
import { type ClaudeConfig } from './ConfigInfoDisplay';
import AlertDialog from '../AlertDialog';
import type { AlertType } from '../AlertDialog';
import ConfirmDialog from '../ConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import ProviderDialog from '../ProviderDialog';

// 导入拆分后的组件
import SettingsHeader from './SettingsHeader';
import SettingsSidebar, { type SettingsTab } from './SettingsSidebar';
import BasicConfigSection from './BasicConfigSection';
import ProviderManageSection from './ProviderManageSection';
import UsageSection from './UsageSection';
import PlaceholderSection from './PlaceholderSection';
import CommunitySection from './CommunitySection';
import { SkillsSettingsSection } from '../skills';

import styles from './style.module.less';

interface SettingsViewProps {
  onClose: () => void;
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

const SettingsView = ({ onClose }: SettingsViewProps) => {
  const { t } = useTranslation();
  const [currentTab, setCurrentTab] = useState<SettingsTab>('basic');
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);

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

  // 主题状态
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    // 从 localStorage 读取主题设置
    const savedTheme = localStorage.getItem('theme');
    return (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
  });

  // Node.js 路径（手动指定时使用）
  const [nodePath, setNodePath] = useState('');
  const [savingNodePath, setSavingNodePath] = useState(false);

  // Toast 状态管理
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast 辅助函数
  const addToast = (message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
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
    showAlert('success', '切换成功', message);
  };

  useEffect(() => {
    // 设置全局回调
    window.updateProviders = (jsonStr: string) => {
      try {
        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
        setProviders(providersList);
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
      showAlert('error', '操作失败', message);
      setLoading(false);
    };

    window.showSwitchSuccess = (message: string) => {
      console.log('[SettingsView] window.showSwitchSuccess called:', message);
      showSwitchSuccess(message);
    };

    window.updateNodePath = (path: string) => {
      console.log('[SettingsView] window.updateNodePath called:', path);
      setNodePath(path || '');
      setSavingNodePath(false);
    };

    // 加载供应商列表
    loadProviders();
    // 加载 Claude CLI 当前配置
    loadClaudeConfig();
    // 加载 Node.js 路径
    sendToJava('get_node_path:');

    return () => {
      window.updateProviders = undefined;
      window.updateActiveProvider = undefined;
      window.updateCurrentClaudeConfig = undefined;
      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateNodePath = undefined;
    };
  }, []);

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

  const loadProviders = () => {
    setLoading(true);
    sendToJava('get_providers:');
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
      showAlert('warning', '提示', '请输入供应商名称');
      return;
    }

    // 解析 JSON 配置
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(data.jsonConfig || '{}');
    } catch (e) {
      showAlert('error', '错误', '配置 JSON 格式错误，请修正后再保存');
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
      addToast('供应商添加成功', 'success');
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
      addToast('供应商更新成功', 'success');

      // 如果是当前正在使用的供应商，更新后立即重新应用配置
      if (isActive) {
        console.log('[SettingsView] Re-applying active provider config:', providerId);
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
    addToast('供应商删除成功', 'success');
    setLoading(true);
    setDeleteConfirm({ isOpen: false, provider: null });
  };

  const cancelDeleteProvider = () => {
    setDeleteConfirm({ isOpen: false, provider: null });
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
          onTabChange={setCurrentTab}
          isCollapsed={isCollapsed}
          onToggleCollapse={toggleManualCollapse}
        />

        {/* 内容区域 */}
        <div className={`${styles.settingsContent} ${currentTab === 'providers' ? styles.providerSettingsContent : ''}`}>
          {/* 基础配置 */}
          {currentTab === 'basic' && (
            <BasicConfigSection
              theme={theme}
              onThemeChange={setTheme}
              nodePath={nodePath}
              onNodePathChange={setNodePath}
              onSaveNodePath={handleSaveNodePath}
              savingNodePath={savingNodePath}
            />
          )}

          {/* 供应商管理 */}
          {currentTab === 'providers' && (
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

          {/* 使用统计 */}
          {currentTab === 'usage' && <UsageSection />}

          {/* MCP服务器 */}
          {currentTab === 'mcp' && <PlaceholderSection type="mcp" />}

          {/* 权限配置 */}
          {currentTab === 'permissions' && <PlaceholderSection type="permissions" />}

          {/* Agents */}
          {currentTab === 'agents' && <PlaceholderSection type="agents" />}

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
        title="确认删除"
        message={t('settings.provider.deleteProviderMessage', { name: deleteConfirm.provider?.name || '' })}
        confirmText="删除"
        cancelText="取消"
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

      {/* Toast 通知 */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export default SettingsView;
