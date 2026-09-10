/**
 * Dialog collection for the MCP settings panel
 */

import type { McpServer, McpPreset } from '../../../types/mcp';
import type { RefreshLog } from '../types';
import type { McpProvider } from '../providerSelection';
import { McpServerDialog } from '../McpServerDialog';
import { McpPresetDialog } from '../McpPresetDialog';
import { McpMarketplaceDialog } from '../McpMarketplaceDialog';
import { McpImportDialog } from '../McpImportDialog';
import { McpHelpDialog } from '../McpHelpDialog';
import { McpConfirmDialog } from '../McpConfirmDialog';
import { McpLogDialog } from '../McpLogDialog';

export interface McpDialogsProps {
  currentProvider: McpProvider;
  existingIds: string[];
  showServerDialog: boolean;
  editingServer: McpServer | null;
  onCloseServerDialog: () => void;
  onSaveServer: (server: McpServer) => void;
  showPresetDialog: boolean;
  onClosePresetDialog: () => void;
  onSelectPreset: (preset: McpPreset) => void;
  showMarketplaceDialog: boolean;
  onCloseMarketplaceDialog: () => void;
  showImportDialog: boolean;
  onCloseImportDialog: () => void;
  onImportServers: (servers: McpServer[]) => void;
  showHelpDialog: boolean;
  onCloseHelpDialog: () => void;
  showConfirmDialog: boolean;
  deletingServer: McpServer | null;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  showLogDialog: boolean;
  refreshLogs: RefreshLog[];
  onCloseLogDialog: () => void;
  onClearLogs: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function McpDialogs({
  currentProvider,
  existingIds,
  showServerDialog,
  editingServer,
  onCloseServerDialog,
  onSaveServer,
  showPresetDialog,
  onClosePresetDialog,
  onSelectPreset,
  showMarketplaceDialog,
  onCloseMarketplaceDialog,
  showImportDialog,
  onCloseImportDialog,
  onImportServers,
  showHelpDialog,
  onCloseHelpDialog,
  showConfirmDialog,
  deletingServer,
  onConfirmDelete,
  onCancelDelete,
  showLogDialog,
  refreshLogs,
  onCloseLogDialog,
  onClearLogs,
  t,
}: McpDialogsProps) {
  return (
    <>
      {showServerDialog && (
        <McpServerDialog
          server={editingServer}
          existingIds={existingIds}
          currentProvider={currentProvider}
          onClose={onCloseServerDialog}
          onSave={onSaveServer}
        />
      )}

      {showPresetDialog && (
        <McpPresetDialog
          onClose={onClosePresetDialog}
          onSelect={onSelectPreset}
        />
      )}

      {showMarketplaceDialog && (
        <McpMarketplaceDialog
          currentProvider={currentProvider}
          existingIds={existingIds}
          onClose={onCloseMarketplaceDialog}
          onSelect={onSaveServer}
        />
      )}

      {showImportDialog && (
        <McpImportDialog
          currentProvider={currentProvider}
          existingIds={existingIds}
          onClose={onCloseImportDialog}
          onImport={onImportServers}
        />
      )}

      {showHelpDialog && (
        <McpHelpDialog onClose={onCloseHelpDialog} />
      )}

      {showConfirmDialog && deletingServer && (
        <McpConfirmDialog
          title={t('mcp.deleteTitle')}
          message={t('mcp.deleteMessage', { name: deletingServer.name || deletingServer.id })}
          confirmText={t('mcp.deleteConfirm')}
          cancelText={t('mcp.cancel')}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      )}

      {showLogDialog && (
        <McpLogDialog
          logs={refreshLogs.map(log => ({
            id: log.id,
            timestamp: log.timestamp,
            serverName: log.serverName || '',
            level: log.type === 'warning' ? 'warn' : log.type,
            message: log.message
          }))}
          onClose={onCloseLogDialog}
          onClear={onClearLogs}
        />
      )}
    </>
  );
}
