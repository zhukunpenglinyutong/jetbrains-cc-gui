import type { ToastMessage } from '../Toast';
import type { ProviderManageTab } from './ProviderTabSection';
import BasicTab from './BasicTab';
import ProviderTabSection from './ProviderTabSection';
import DependencySection from './DependencySection';
import UsageSection from './UsageSection';
import PlaceholderSection from './PlaceholderSection';
import PermissionsSection from './PermissionsSection';
import CommunitySection from './CommunitySection';
import AgentSection from './AgentSection';
import PromptSection from './PromptSection';
import CommitSection from './CommitSection';
import PromptEnhancerSection from './PromptEnhancerSection';
import OtherSettingsSection from './OtherSettingsSection';
import PetSettingsSection from './PetSettingsSection';
import { SkillsSettingsSection } from '../skills/SkillsSettingsSection';
import type {
  UseSettingsThemeSyncReturn,
  UseSettingsBasicActionsReturn,
  UseProviderManagementReturn,
  UseCodexProviderManagementReturn,
  UseAgentManagementReturn,
} from './hooks';

export interface SettingsTabPanelProps {
  currentProvider: 'claude' | 'codex' | string;
  initialProviderSubTab?: ProviderManageTab;
  addToast: (message: string, type?: ToastMessage['type']) => void;
  themeSync: UseSettingsThemeSyncReturn;
  basicActions: UseSettingsBasicActionsReturn;
  providerManagement: UseProviderManagementReturn;
  codexProviderManagement: UseCodexProviderManagementReturn;
  agentManagement: UseAgentManagementReturn;
}

export const BasicPanel = ({ themeSync, basicActions, addToast }: SettingsTabPanelProps) => (
  <BasicTab themeSync={themeSync} basicActions={basicActions} addToast={addToast} />
);

export const ProvidersPanel = ({
  currentProvider,
  initialProviderSubTab,
  providerManagement,
  codexProviderManagement,
  addToast,
}: SettingsTabPanelProps) => (
  <ProviderTabSection
    currentProvider={currentProvider}
    initialSubTab={initialProviderSubTab}
    providers={providerManagement.providers}
    loading={providerManagement.loading}
    onAddProvider={providerManagement.handleAddProvider}
    onEditProvider={providerManagement.handleEditProvider}
    onDeleteProvider={providerManagement.handleDeleteProvider}
    onSwitchProvider={providerManagement.handleSwitchProvider}
    codexProviders={codexProviderManagement.codexProviders}
    codexLoading={codexProviderManagement.codexLoading}
    onAddCodexProvider={codexProviderManagement.handleAddCodexProvider}
    onEditCodexProvider={codexProviderManagement.handleEditCodexProvider}
    onDeleteCodexProvider={codexProviderManagement.handleDeleteCodexProvider}
    onSwitchCodexProvider={codexProviderManagement.handleSwitchCodexProvider}
    onRevokeCodexLocalConfigAuthorization={codexProviderManagement.handleRevokeCodexLocalConfigAuthorization}
    addToast={addToast}
  />
);

export const DependenciesPanel = ({ addToast }: SettingsTabPanelProps) => (
  <DependencySection addToast={addToast} isActive />
);

export const UsagePanel = () => <UsageSection />;

export const McpPanel = ({ currentProvider }: SettingsTabPanelProps) => (
  <PlaceholderSection type="mcp" currentProvider={currentProvider} />
);

export const PermissionsPanel = ({ currentProvider, basicActions }: SettingsTabPanelProps) => (
  currentProvider === 'codex' ? (
    <PermissionsSection
      codexSandboxMode={basicActions.codexSandboxMode}
      onCodexSandboxModeChange={basicActions.handleCodexSandboxModeChange}
    />
  ) : (
    <PlaceholderSection type="permissions" />
  )
);

export const PromptEnhancerPanel = ({ basicActions }: SettingsTabPanelProps) => (
  <PromptEnhancerSection
    promptEnhancerConfig={basicActions.promptEnhancerConfig}
    onPromptEnhancerProviderChange={basicActions.handlePromptEnhancerProviderChange}
    onPromptEnhancerModelChange={basicActions.handlePromptEnhancerModelChange}
    onPromptEnhancerResetToDefault={basicActions.handlePromptEnhancerResetToDefault}
  />
);

export const CommitPanel = ({ basicActions }: SettingsTabPanelProps) => (
  <CommitSection
    commitAiConfig={basicActions.commitAiConfig}
    onCommitAiProviderChange={basicActions.handleCommitAiProviderChange}
    onCommitAiModelChange={basicActions.handleCommitAiModelChange}
    onCommitAiResetToDefault={basicActions.handleCommitAiResetToDefault}
    commitPrompt={basicActions.commitPrompt}
    projectCommitPrompt={basicActions.projectCommitPrompt}
    onCommitPromptChange={basicActions.setCommitPrompt}
    onProjectCommitPromptChange={basicActions.setProjectCommitPrompt}
    onSaveCommitPrompt={basicActions.handleSaveCommitPrompt}
    onSaveProjectCommitPrompt={basicActions.handleSaveProjectCommitPrompt}
    savingCommitPrompt={basicActions.savingCommitPrompt}
    savingProjectCommitPrompt={basicActions.savingProjectCommitPrompt}
  />
);

export const AgentsPanel = ({ agentManagement }: SettingsTabPanelProps) => (
  <AgentSection
    agents={agentManagement.agents}
    loading={agentManagement.agentsLoading}
    onAdd={agentManagement.handleAddAgent}
    onEdit={agentManagement.handleEditAgent}
    onDelete={agentManagement.handleDeleteAgent}
    onExport={agentManagement.handleExportAgents}
    onImport={agentManagement.handleImportAgentsFile}
  />
);

export const PromptsPanel = ({ currentProvider, addToast }: SettingsTabPanelProps) => (
  <PromptSection
    currentProvider={currentProvider}
    onSuccess={(msg) => addToast(msg, 'success')}
  />
);

export const SkillsPanel = ({ currentProvider }: SettingsTabPanelProps) => (
  <SkillsSettingsSection currentProvider={currentProvider} />
);

export const PetPanel = ({ addToast }: SettingsTabPanelProps) => (
  <PetSettingsSection addToast={addToast} />
);

export const OtherPanel = ({ basicActions }: SettingsTabPanelProps) => (
  <OtherSettingsSection
    historyCompletionEnabled={basicActions.historyCompletionEnabled}
    onHistoryCompletionEnabledChange={(enabled) => {
      basicActions.setHistoryCompletionEnabled(enabled);
      localStorage.setItem('historyCompletionEnabled', enabled.toString());
      // Dispatch custom event for same-tab sync (localStorage 'storage' event only fires for cross-tab)
      window.dispatchEvent(new CustomEvent('historyCompletionChanged', { detail: { enabled } }));
    }}
  />
);

export const CommunityPanel = ({ addToast }: SettingsTabPanelProps) => (
  <CommunitySection addToast={addToast} />
);
