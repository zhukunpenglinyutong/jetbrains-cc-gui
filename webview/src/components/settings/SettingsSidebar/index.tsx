import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export type SettingsTab = 'basic' | 'providers' | 'dependencies' | 'usage' | 'permissions' | 'commit' | 'mcp' | 'agents' | 'skills' | 'other' | 'community';

interface SidebarItem {
  key: SettingsTab;
  icon: string;
  labelKey: string; // 改为翻译 key
}

const sidebarItems: SidebarItem[] = [
  { key: 'basic', icon: 'codicon-settings-gear', labelKey: 'settings.basic.title' },
  { key: 'providers', icon: 'codicon-vm-connect', labelKey: 'settings.providers' },
  { key: 'dependencies', icon: 'codicon-extensions', labelKey: 'settings.dependencies' },
  { key: 'usage', icon: 'codicon-graph', labelKey: 'settings.usage' },
  { key: 'mcp', icon: 'codicon-server', labelKey: 'settings.mcp' },
  { key: 'permissions', icon: 'codicon-shield', labelKey: 'settings.permissions' },
  { key: 'commit', icon: 'codicon-git-commit', labelKey: 'settings.commit.title' },
  { key: 'agents', icon: 'codicon-robot', labelKey: 'settings.agents' },
  { key: 'skills', icon: 'codicon-book', labelKey: 'settings.skills' },
  { key: 'other', icon: 'codicon-ellipsis', labelKey: 'settings.other.title' },
  { key: 'community', icon: 'codicon-comment-discussion', labelKey: 'settings.community' },
];

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

  return (
    <div className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarItems}>
        {sidebarItems.map((item) => {
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
        })}
      </div>

      {/* 折叠按钮 */}
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
