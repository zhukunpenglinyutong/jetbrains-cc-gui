import {useMemo, useState} from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

export type SettingsTab = 'basic' | 'providers' | 'dependencies' | 'usage' | 'permissions' | 'promptEnhancer' | 'commit' | 'mcp' | 'agents' | 'prompts' | 'skills' | 'other' | 'community';

interface SidebarItem {
  key: SettingsTab;
  icon: string;
  labelKey: string;
}

interface SidebarGroup {
  labelKey: string;
  items: Omit<SidebarItem, 'badge'>[];
}

const sidebarGroups: SidebarGroup[] = [
  {
    labelKey: 'settings.sidebar.group.core',
    items: [
      { key: 'basic', icon: 'settings', labelKey: 'settings.basic.title' },
      { key: 'providers', icon: 'plug', labelKey: 'settings.providers' },
      { key: 'dependencies', icon: 'package', labelKey: 'settings.dependencies' },
      { key: 'usage', icon: 'barChart', labelKey: 'settings.usage' },
    ],
  },
  {
    labelKey: 'settings.sidebar.group.tools',
    items: [
      { key: 'mcp', icon: 'server', labelKey: 'settings.mcp' },
      { key: 'permissions', icon: 'shield', labelKey: 'settings.permissions' },
      { key: 'promptEnhancer', icon: 'sparkles', labelKey: 'settings.promptEnhancer.title' },
      { key: 'commit', icon: 'gitCommit', labelKey: 'settings.commit.title' },
    ],
  },
  {
    labelKey: 'settings.sidebar.group.resources',
    items: [
      { key: 'agents', icon: 'bot', labelKey: 'settings.agents' },
      { key: 'prompts', icon: 'fileText', labelKey: 'settings.prompts' },
      { key: 'skills', icon: 'bookOpen', labelKey: 'settings.skills' },
    ],
  },
  {
    labelKey: 'settings.sidebar.group.other',
    items: [
      { key: 'other', icon: 'moreHorizontal', labelKey: 'settings.other.title' },
      { key: 'community', icon: 'messageCircle', labelKey: 'settings.community' },
    ],
  },
];

// SVG icon paths (Lucide-style, 24x24 viewBox, stroke-based)
const iconPaths: Record<string, string> = {
  // Settings/Sliders
  settings:
    '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  // Plug
  plug:
    '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/>',
  // Package
  package:
    '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  // Bar Chart
  barChart:
    '<path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>',
  // Server
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  // Shield
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  // Sparkles
  sparkles:
    '<path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  // Git Commit
  gitCommit:
    '<circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/>',
  // Bot / Robot
  bot:
    '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4"/><path d="M8 12h.01"/><path d="M16 12h.01"/><path d="M9 15h6"/><path d="M2.5 11.5H5"/><path d="M19 11.5h2.5"/>',
  // File Text
  fileText:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  // Book Open
  bookOpen:
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  // More Horizontal (ellipsis)
  moreHorizontal:
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  // Message Circle
  messageCircle:
    '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
};

/**
 * Render an SVG icon by name using pre-defined paths.
 * All icons use a 24×24 viewBox with stroke-based rendering.
 */
const SvgIcon = ({ name }: { name: string }) => (
  <span className={styles.sidebarIcon}>
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: iconPaths[name] || '' }}
    />
  </span>
);

// Fallback group labels (used if i18n keys are not yet registered)
const GROUP_LABEL_FALLBACKS: Record<string, string> = {
  'settings.sidebar.group.core': 'Core',
  'settings.sidebar.group.tools': 'Tools',
  'settings.sidebar.group.resources': 'Resources',
  'settings.sidebar.group.other': 'Other',
};

interface SettingsSidebarProps {
  currentTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  disabledTabs?: SettingsTab[];
  onDisabledTabClick?: (tab: SettingsTab) => void;
  providerCount?: number;
  agentCount?: number;
}

const SettingsSidebar = ({
  currentTab,
  onTabChange,
  isCollapsed,
  onToggleCollapse,
  disabledTabs = [],
  onDisabledTabClick,
  providerCount,
  agentCount,
}: SettingsSidebarProps) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');

  // Build badge map from props
  const badgeMap = useMemo(() => {
    const map: Partial<Record<SettingsTab, number | string>> = {};
    if (providerCount !== undefined && providerCount > 0) {
      map.providers = providerCount;
    }
    if (agentCount !== undefined && agentCount > 0) {
      map.agents = agentCount;
    }
    return map;
  }, [providerCount, agentCount]);

  // Filter groups by search query
  const filteredGroups = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return sidebarGroups;

    return sidebarGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          const label = t(item.labelKey).toLowerCase();
          return label.includes(q);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [searchQuery, t]);

  return (
    <div className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      {/* Search */}
      <div className={styles.sidebarSearch}>
        <div className={styles.searchInputWrapper}>
          <span className={styles.searchIcon}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.8-3.8" />
            </svg>
          </span>
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t('settings.sidebar.search', 'Search...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Grouped items */}
      {filteredGroups.map((group) => {
        const groupLabel = t(group.labelKey);
        const displayLabel = groupLabel === group.labelKey
          ? (GROUP_LABEL_FALLBACKS[group.labelKey] || group.labelKey)
          : groupLabel;

        return (
          <div key={group.labelKey}>
            <div className={styles.sidebarSectionLabel}>{displayLabel}</div>
            <div className={styles.sidebarItems}>
              {group.items.map((item) => {
                const label = t(item.labelKey);
                const isDisabled = disabledTabs.includes(item.key);
                const badge = badgeMap[item.key];
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
                    <SvgIcon name={item.icon} />
                    <span className={styles.sidebarItemText}>{label}</span>
                    {badge !== undefined && (
                      <span className={styles.sidebarItemBadge}>{badge}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Collapse toggle button */}
      <div
        className={styles.sidebarToggle}
        onClick={onToggleCollapse}
        title={isCollapsed ? t('settings.sidebar.expand') : t('settings.sidebar.collapse')}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {isCollapsed
            ? <><path d="M9 18l6-6-6-6" /></>
            : <><path d="M15 18l-6-6 6-6" /></>
          }
        </svg>
      </div>
    </div>
  );
};

export default SettingsSidebar;
