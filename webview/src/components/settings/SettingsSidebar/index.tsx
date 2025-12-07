import styles from './style.module.less';

export type SettingsTab = 'basic' | 'providers' | 'usage' | 'permissions' | 'mcp' | 'agents' | 'skills' | 'community';

interface SidebarItem {
  key: SettingsTab;
  icon: string;
  label: string;
}

const sidebarItems: SidebarItem[] = [
  { key: 'basic', icon: 'codicon-settings-gear', label: '基础配置' },
  { key: 'providers', icon: 'codicon-vm-connect', label: '供应商管理' },
  { key: 'usage', icon: 'codicon-graph', label: '使用统计' },
  { key: 'mcp', icon: 'codicon-server', label: 'MCP服务器' },
  { key: 'permissions', icon: 'codicon-shield', label: '权限配置' },
  { key: 'agents', icon: 'codicon-robot', label: 'Agents' },
  { key: 'skills', icon: 'codicon-book', label: 'Skills' },
  { key: 'community', icon: 'codicon-comment-discussion', label: '官方交流群' },
];

interface SettingsSidebarProps {
  currentTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

const SettingsSidebar = ({
  currentTab,
  onTabChange,
  isCollapsed,
  onToggleCollapse,
}: SettingsSidebarProps) => {
  return (
    <div className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarItems}>
        {sidebarItems.map((item) => (
          <div
            key={item.key}
            className={`${styles.sidebarItem} ${currentTab === item.key ? styles.active : ''}`}
            onClick={() => onTabChange(item.key)}
            title={isCollapsed ? item.label : ''}
          >
            <span className={`codicon ${item.icon}`} />
            <span className={styles.sidebarItemText}>{item.label}</span>
          </div>
        ))}
      </div>

      {/* 折叠按钮 */}
      <div
        className={styles.sidebarToggle}
        onClick={onToggleCollapse}
        title={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        <span className={`codicon ${isCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-left'}`} />
      </div>
    </div>
  );
};

export default SettingsSidebar;
