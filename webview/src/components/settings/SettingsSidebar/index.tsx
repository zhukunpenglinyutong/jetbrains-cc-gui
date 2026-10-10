import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export type SettingsTab = 'basic' | 'providers' | 'dependencies' | 'usage' | 'permissions' | 'promptEnhancer' | 'commit' | 'mcp' | 'agents' | 'prompts' | 'skills' | 'hooks' | 'pet' | 'other' | 'community';

interface SidebarItem {
  key: SettingsTab;
  icon: string;
  labelKey: string; // Changed to i18n translation key
}

const sidebarGroups: { key: string; items: SidebarItem[] }[] = [
  { key: 'connection', items: [
    { key: 'basic', icon: 'codicon-settings-gear', labelKey: 'settings.basic.title' },
    { key: 'providers', icon: 'codicon-vm-connect', labelKey: 'settings.providers' },
    { key: 'dependencies', icon: 'codicon-extensions', labelKey: 'settings.dependencies' },
    { key: 'permissions', icon: 'codicon-shield', labelKey: 'settings.permissions' },
  ] },
  { key: 'prompts', items: [
    { key: 'prompts', icon: 'codicon-notebook', labelKey: 'settings.prompts' },
    { key: 'promptEnhancer', icon: 'codicon-sparkle', labelKey: 'settings.promptEnhancer.title' },
    { key: 'commit', icon: 'codicon-git-commit', labelKey: 'settings.commit.title' },
  ] },
  { key: 'extensions', items: [
    { key: 'agents', icon: 'codicon-robot', labelKey: 'settings.agents' },
    { key: 'skills', icon: 'codicon-book', labelKey: 'settings.skills' },
    { key: 'mcp', icon: 'codicon-server', labelKey: 'settings.mcp' },
    { key: 'hooks', icon: 'codicon-symbol-event', labelKey: 'settings.hooks.title' },
    { key: 'pet', icon: 'codicon-hubot', labelKey: 'settings.pet.title' },
  ] },
  { key: 'maintenance', items: [
    { key: 'usage', icon: 'codicon-graph', labelKey: 'settings.usage' },
    { key: 'other', icon: 'codicon-ellipsis', labelKey: 'settings.other.title' },
  ] },
];

const communityItem: SidebarItem = {
  key: 'community', icon: 'codicon-comment-discussion', labelKey: 'settings.community',
};

interface SettingsSidebarProps {
  currentTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  disabledTabs?: SettingsTab[];
  onDisabledTabClick?: (tab: SettingsTab) => void;
}

const SettingsSidebar = ({
  currentTab,
  onTabChange,
  isCollapsed,
  onToggleCollapse,
  disabledTabs = [],
  onDisabledTabClick,
}: SettingsSidebarProps) => {
  const { t } = useTranslation();

  const renderItem = (item: SidebarItem) => {
    const label = t(item.labelKey);
    const isDisabled = disabledTabs.includes(item.key);
    return (
      <div
        key={item.key}
        className={`${styles.sidebarItem} ${currentTab === item.key ? styles.active : ''} ${isDisabled ? styles.disabled : ''}`}
        onClick={() => {
          if (isDisabled) {
            onDisabledTabClick?.(item.key);
            return;
          }
          onTabChange(item.key);
        }}
        title={isCollapsed ? label : ''}
        aria-disabled={isDisabled}
      >
        <span className={`codicon ${item.icon}`} />
        <span className={styles.sidebarItemText}>{label}</span>
      </div>
    );
  };

  return (
    <div className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarItems}>
        {sidebarGroups.map((group) => (
          <div key={group.key} className={styles.sidebarGroup}>
            {group.items.map(renderItem)}
          </div>
        ))}
      </div>
      <div className={styles.sidebarFooter}>
        {renderItem(communityItem)}
      </div>

      {/* Collapse toggle button */}
      <div
        className={styles.sidebarToggle}
        onClick={onToggleCollapse}
        title={isCollapsed ? t('settings.sidebar.expand') : t('settings.sidebar.collapse')}
      >
        <span className={`codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-left'}`} />
      </div>
    </div>
  );
};

export default SettingsSidebar;
