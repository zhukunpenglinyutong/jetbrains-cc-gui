import SettingsDialogs from './SettingsDialogs';
import type {
  UseSettingsPageStateReturn,
  UseProviderManagementReturn,
  UseCodexProviderManagementReturn,
  UseAgentManagementReturn,
} from './hooks';
import type { SaveProviderFromDialogData } from './hooks/useSaveProviderFromDialog';
import type { CodexProviderConfig } from '../../types/provider';

interface SettingsDialogsHostProps {
  pageState: UseSettingsPageStateReturn;
  providerManagement: UseProviderManagementReturn;
  codexProviderManagement: UseCodexProviderManagementReturn;
  agentManagement: UseAgentManagementReturn;
  onSaveProvider: (data: SaveProviderFromDialogData) => void;
  onSaveCodexProvider: (providerData: CodexProviderConfig) => void;
  onSaveAgent: (data: { name: string; prompt: string }) => void;
}

// All dialogs (alert, confirm, provider, agent, prompt, codex)
const SettingsDialogsHost = ({
  pageState,
  providerManagement,
  codexProviderManagement,
  agentManagement,
  onSaveProvider,
  onSaveCodexProvider,
  onSaveAgent,
}: SettingsDialogsHostProps) => (
  <SettingsDialogs
    alertDialog={pageState.alertDialog}
    onCloseAlert={pageState.closeAlert}
    providerDialog={providerManagement.providerDialog}
    deleteConfirm={providerManagement.deleteConfirm}
    onCloseProviderDialog={providerManagement.handleCloseProviderDialog}
    onSaveProvider={onSaveProvider}
    onDeleteProvider={providerManagement.handleDeleteProvider}
    onConfirmDeleteProvider={providerManagement.confirmDeleteProvider}
    onCancelDeleteProvider={providerManagement.cancelDeleteProvider}
    codexProviderDialog={codexProviderManagement.codexProviderDialog}
    deleteCodexConfirm={codexProviderManagement.deleteCodexConfirm}
    onCloseCodexProviderDialog={codexProviderManagement.handleCloseCodexProviderDialog}
    onSaveCodexProvider={onSaveCodexProvider}
    onConfirmDeleteCodexProvider={codexProviderManagement.confirmDeleteCodexProvider}
    onCancelDeleteCodexProvider={codexProviderManagement.cancelDeleteCodexProvider}
    agentDialog={agentManagement.agentDialog}
    deleteAgentConfirm={agentManagement.deleteAgentConfirm}
    onCloseAgentDialog={agentManagement.handleCloseAgentDialog}
    onSaveAgent={onSaveAgent}
    onConfirmDeleteAgent={agentManagement.confirmDeleteAgent}
    onCancelDeleteAgent={agentManagement.cancelDeleteAgent}
    agentExportDialog={agentManagement.exportDialog}
    agentImportPreviewDialog={agentManagement.importPreviewDialog}
    agents={agentManagement.agents}
    onCloseAgentExportDialog={agentManagement.handleCloseExportDialog}
    onConfirmAgentExport={agentManagement.handleConfirmExport}
    onCloseAgentImportPreview={agentManagement.handleCloseImportPreview}
    onSaveImportedAgents={agentManagement.handleSaveImportedAgents}
    addToast={pageState.addToast}
  />
);

export default SettingsDialogsHost;
