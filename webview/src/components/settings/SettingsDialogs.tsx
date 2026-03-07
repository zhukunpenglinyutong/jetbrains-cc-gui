// SettingsDialogs.tsx
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, CodexProviderConfig } from '../../types/provider';
import type { AgentConfig } from '../../types/agent';
import AlertDialog from '../AlertDialog';
import type { AlertType } from '../AlertDialog';
import ConfirmDialog from '../ConfirmDialog';
import ProviderDialog from '../ProviderDialog';
import CodexProviderDialog from '../CodexProviderDialog';
import AgentDialog from '../AgentDialog';
import AgentExportDialog from './AgentSection/AgentExportDialog';
import AgentImportConfirmDialog from './AgentSection/AgentImportConfirmDialog';
import type { ToastMessage } from '../Toast';
import type { ProviderDialogState, DeleteConfirmState } from './hooks/useProviderManagement';
import type { AgentDialogState, DeleteAgentConfirmState, ExportDialogState as AgentExportDialogState, ImportPreviewDialogState as AgentImportPreviewDialogState } from './hooks/useAgentManagement';
import type { CodexProviderDialogState, DeleteCodexConfirmState } from './hooks/useCodexProviderManagement';
import type { ConflictStrategy } from '../../types/import';

interface SettingsDialogsProps {
  // Alert dialog
  alertDialog: { isOpen: boolean; type: AlertType; title: string; message: string };
  onCloseAlert: () => void;

  // Provider dialog
  providerDialog: ProviderDialogState;
  deleteConfirm: DeleteConfirmState;
  onCloseProviderDialog: () => void;
  onSaveProvider: (data: { providerName: string; remark: string; apiKey: string; apiUrl: string; jsonConfig: string }) => void;
  onDeleteProvider: (provider: ProviderConfig) => void;
  onConfirmDeleteProvider: () => void;
  onCancelDeleteProvider: () => void;

  // Codex provider dialog
  codexProviderDialog: CodexProviderDialogState;
  deleteCodexConfirm: DeleteCodexConfirmState;
  onCloseCodexProviderDialog: () => void;
  onSaveCodexProvider: (data: CodexProviderConfig) => void;
  onConfirmDeleteCodexProvider: () => void;
  onCancelDeleteCodexProvider: () => void;

  // Agent dialog
  agentDialog: AgentDialogState;
  deleteAgentConfirm: DeleteAgentConfirmState;
  onCloseAgentDialog: () => void;
  onSaveAgent: (data: { name: string; prompt: string }) => void;
  onConfirmDeleteAgent: () => void;
  onCancelDeleteAgent: () => void;

  // Agent import/export
  agentExportDialog: AgentExportDialogState;
  agentImportPreviewDialog: AgentImportPreviewDialogState;
  agents: AgentConfig[];
  onCloseAgentExportDialog: () => void;
  onConfirmAgentExport: (selectedIds: string[]) => void;
  onCloseAgentImportPreview: () => void;
  onSaveImportedAgents: (selectedIds: string[], strategy: ConflictStrategy) => void;

  // Note: Prompt dialogs are now handled in PromptSection component

  addToast: (message: string, type?: ToastMessage['type']) => void;
}

const SettingsDialogs = ({
  alertDialog,
  onCloseAlert,
  providerDialog,
  deleteConfirm,
  onCloseProviderDialog,
  onSaveProvider,
  onDeleteProvider,
  onConfirmDeleteProvider,
  onCancelDeleteProvider,
  codexProviderDialog,
  deleteCodexConfirm,
  onCloseCodexProviderDialog,
  onSaveCodexProvider,
  onConfirmDeleteCodexProvider,
  onCancelDeleteCodexProvider,
  agentDialog,
  deleteAgentConfirm,
  onCloseAgentDialog,
  onSaveAgent,
  onConfirmDeleteAgent,
  onCancelDeleteAgent,
  agentExportDialog,
  agentImportPreviewDialog,
  agents,
  onCloseAgentExportDialog,
  onConfirmAgentExport,
  onCloseAgentImportPreview,
  onSaveImportedAgents,
  addToast,
}: SettingsDialogsProps) => {
  const { t } = useTranslation();

  return (
    <>
      {/* In-page alert dialog */}
      <AlertDialog
        isOpen={alertDialog.isOpen}
        type={alertDialog.type}
        title={alertDialog.title}
        message={alertDialog.message}
        onClose={onCloseAlert}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title={t('settings.provider.deleteConfirm')}
        message={t('settings.provider.deleteProviderMessage', { name: deleteConfirm.provider?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmDeleteProvider}
        onCancel={onCancelDeleteProvider}
      />

      {/* Provider add/edit dialog */}
      <ProviderDialog
        isOpen={providerDialog.isOpen}
        provider={providerDialog.provider}
        onClose={onCloseProviderDialog}
        onSave={onSaveProvider}
        onDelete={onDeleteProvider}
        canDelete={true}
        addToast={addToast}
      />

      {/* Agent add/edit dialog */}
      <AgentDialog
        isOpen={agentDialog.isOpen}
        agent={agentDialog.agent}
        onClose={onCloseAgentDialog}
        onSave={onSaveAgent}
      />

      {/* Agent delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteAgentConfirm.isOpen}
        title={t('settings.agent.deleteConfirmTitle')}
        message={t('settings.agent.deleteConfirmMessage', { name: deleteAgentConfirm.agent?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmDeleteAgent}
        onCancel={onCancelDeleteAgent}
      />

      {/* Note: Prompt dialogs are now rendered in PromptSection component */}

      {/* Codex provider add/edit dialog */}
      <CodexProviderDialog
        isOpen={codexProviderDialog.isOpen}
        provider={codexProviderDialog.provider}
        onClose={onCloseCodexProviderDialog}
        onSave={onSaveCodexProvider}
        addToast={addToast}
      />

      {/* Codex provider delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteCodexConfirm.isOpen}
        title={t('settings.codexProvider.deleteConfirmTitle')}
        message={t('settings.codexProvider.deleteConfirmMessage', { name: deleteCodexConfirm.provider?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmDeleteCodexProvider}
        onCancel={onCancelDeleteCodexProvider}
      />

      {/* Agent export dialog */}
      {agentExportDialog.isOpen && (
        <AgentExportDialog
          agents={agents}
          onConfirm={onConfirmAgentExport}
          onCancel={onCloseAgentExportDialog}
        />
      )}

      {/* Agent import preview dialog */}
      {agentImportPreviewDialog.isOpen && agentImportPreviewDialog.previewData && (
        <AgentImportConfirmDialog
          previewData={agentImportPreviewDialog.previewData}
          onConfirm={onSaveImportedAgents}
          onCancel={onCloseAgentImportPreview}
        />
      )}

      {/* Note: Prompt import/export dialogs are now rendered in PromptSection component */}
    </>
  );
};

export default SettingsDialogs;
