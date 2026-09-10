import type { ComponentType } from 'react';
import type { ToastMessage } from '../Toast';
import type { SettingsTab } from './SettingsSidebar';
import type { ProviderManageTab } from './ProviderTabSection';
import {
  BasicPanel,
  ProvidersPanel,
  DependenciesPanel,
  UsagePanel,
  McpPanel,
  PermissionsPanel,
  PromptEnhancerPanel,
  CommitPanel,
  AgentsPanel,
  PromptsPanel,
  SkillsPanel,
  PetPanel,
  OtherPanel,
  CommunityPanel,
  type SettingsTabPanelProps,
} from './SettingsTabPanels';
import type {
  UseSettingsThemeSyncReturn,
  UseSettingsBasicActionsReturn,
  UseProviderManagementReturn,
  UseCodexProviderManagementReturn,
  UseAgentManagementReturn,
} from './hooks';
import styles from './style.module.less';

const TAB_PANELS: Record<SettingsTab, ComponentType<SettingsTabPanelProps>> = {
  basic: BasicPanel,
  providers: ProvidersPanel,
  dependencies: DependenciesPanel,
  usage: UsagePanel,
  mcp: McpPanel,
  permissions: PermissionsPanel,
  promptEnhancer: PromptEnhancerPanel,
  commit: CommitPanel,
  agents: AgentsPanel,
  prompts: PromptsPanel,
  skills: SkillsPanel,
  pet: PetPanel,
  other: OtherPanel,
  community: CommunityPanel,
};

interface SettingsContentProps {
  currentTab: SettingsTab;
  currentProvider: 'claude' | 'codex' | string;
  initialProviderSubTab?: ProviderManageTab;
  addToast: (message: string, type?: ToastMessage['type']) => void;
  themeSync: UseSettingsThemeSyncReturn;
  basicActions: UseSettingsBasicActionsReturn;
  providerManagement: UseProviderManagementReturn;
  codexProviderManagement: UseCodexProviderManagementReturn;
  agentManagement: UseAgentManagementReturn;
}

// Content area — mount only the active tab.
// Previously every tab stayed mounted under display:none, which made
// Settings open cost ~all sections (MCP/Skills/TokenTracker/…) at once.
const SettingsContent = ({
  currentTab,
  currentProvider,
  initialProviderSubTab,
  addToast,
  themeSync,
  basicActions,
  providerManagement,
  codexProviderManagement,
  agentManagement,
}: SettingsContentProps) => {
  const ActivePanel = TAB_PANELS[currentTab];
  return (
    <div className={`${styles.settingsContent} ${currentTab === 'providers' ? styles.providerSettingsContent : ''}`}>
      <ActivePanel
        currentProvider={currentProvider}
        initialProviderSubTab={initialProviderSubTab}
        addToast={addToast}
        themeSync={themeSync}
        basicActions={basicActions}
        providerManagement={providerManagement}
        codexProviderManagement={codexProviderManagement}
        agentManagement={agentManagement}
      />
    </div>
  );
};

export default SettingsContent;
