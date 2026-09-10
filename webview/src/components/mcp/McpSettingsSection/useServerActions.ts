/**
 * Dialog visibility state and server action handlers for the MCP settings panel
 */

import { useState, useCallback } from 'react';
import type { McpServer, McpPreset } from '../../../types/mcp';
import { sendToJava } from '../../../utils/bridge';
import { copyToClipboard } from '../../../utils/copyUtils';
import type { ToastMessage } from '../../Toast';

export interface UseServerActionsOptions {
  messagePrefix: string;
  isCodexMode: boolean;
  addToast: (message: string, type?: ToastMessage['type']) => void;
  loadServers: () => void;
  closeDropdown: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useServerActions({
  messagePrefix,
  isCodexMode,
  addToast,
  loadServers,
  closeDropdown,
  t,
}: UseServerActionsOptions) {
  // Dialog state
  const [showServerDialog, setShowServerDialog] = useState(false);
  const [showPresetDialog, setShowPresetDialog] = useState(false);
  const [showMarketplaceDialog, setShowMarketplaceDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showLogDialog, setShowLogDialog] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<McpServer | null>(null);

  // Edit server
  const handleEdit = useCallback((server: McpServer) => {
    setEditingServer(server);
    setShowServerDialog(true);
  }, []);

  // Delete server
  const handleDelete = useCallback((server: McpServer) => {
    setDeletingServer(server);
    setShowConfirmDialog(true);
  }, []);

  // Confirm deletion
  const confirmDelete = useCallback(() => {
    if (deletingServer) {
      sendToJava(`delete_${messagePrefix}mcp_server`, { id: deletingServer.id });
      if (!isCodexMode) {
        addToast(`${t('mcp.deleted')} ${deletingServer.name || deletingServer.id}`, 'success');
        setTimeout(() => loadServers(), 100);
      }
    }
    setShowConfirmDialog(false);
    setDeletingServer(null);
  }, [deletingServer, messagePrefix, isCodexMode, addToast, t, loadServers]);

  // Cancel deletion
  const cancelDelete = useCallback(() => {
    setShowConfirmDialog(false);
    setDeletingServer(null);
  }, []);

  // Add server manually
  const handleAddManual = useCallback(() => {
    closeDropdown();
    setEditingServer(null);
    setShowServerDialog(true);
  }, [closeDropdown]);

  // Add server from marketplace
  const handleAddFromMarket = useCallback(() => {
    closeDropdown();
    setShowMarketplaceDialog(true);
  }, [closeDropdown]);

  // Import servers from a GitHub Copilot configuration
  const handleImportFromCopilot = useCallback(() => {
    closeDropdown();
    setShowImportDialog(true);
  }, [closeDropdown]);

  // Persist imported servers via the same save path as handleSaveServer
  const handleImportServers = useCallback((importedServers: McpServer[]) => {
    importedServers.forEach((server) => {
      sendToJava(`add_${messagePrefix}mcp_server`, server);
    });
    if (!isCodexMode) {
      addToast(`${t('mcp.added')} ${importedServers.length}`, 'success');
      setTimeout(() => loadServers(), 100);
    }
  }, [messagePrefix, isCodexMode, addToast, t, loadServers]);

  // Save server
  const handleSaveServer = useCallback((server: McpServer) => {
    if (editingServer) {
      if (editingServer.id !== server.id) {
        if (isCodexMode) {
          sendToJava('update_codex_mcp_server', { ...server, oldId: editingServer.id });
        } else {
          sendToJava(`delete_${messagePrefix}mcp_server`, { id: editingServer.id });
          sendToJava(`add_${messagePrefix}mcp_server`, server);
          addToast(`${t('mcp.updated')} ${server.name || server.id}`, 'success');
        }
      } else {
        sendToJava(`update_${messagePrefix}mcp_server`, server);
        if (!isCodexMode) {
          addToast(`${t('mcp.saved')} ${server.name || server.id}`, 'success');
        }
      }
    } else {
      sendToJava(`add_${messagePrefix}mcp_server`, server);
      if (!isCodexMode) {
        addToast(`${t('mcp.added')} ${server.name || server.id}`, 'success');
      }
    }

    if (!isCodexMode) {
      setTimeout(() => loadServers(), 100);
    }

    setShowServerDialog(false);
    setEditingServer(null);
  }, [editingServer, messagePrefix, isCodexMode, addToast, t, loadServers]);

  // Select preset
  const handleSelectPreset = useCallback((preset: McpPreset) => {
    const server: McpServer = {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      tags: preset.tags,
      server: { ...preset.server },
      apps: {
        claude: !isCodexMode,
        codex: isCodexMode,
        gemini: false,
      },
      homepage: preset.homepage,
      docs: preset.docs,
      enabled: true,
    };
    sendToJava(`add_${messagePrefix}mcp_server`, server);
    if (!isCodexMode) {
      addToast(`${t('mcp.added')} ${preset.name}`, 'success');
      setTimeout(() => loadServers(), 100);
    }

    setShowPresetDialog(false);
  }, [isCodexMode, messagePrefix, addToast, t, loadServers]);

  // Copy URL
  const handleCopyUrl = useCallback(async (url: string) => {
    const success = await copyToClipboard(url);
    if (success) {
      addToast(t('mcp.linkCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  }, [addToast, t]);

  // Copy server config (redact sensitive values in env/headers)
  const handleCopyConfig = useCallback(async (server: McpServer) => {
    const { env, headers, ...safeFields } = server.server;
    const serverConfig: Record<string, unknown> = { ...safeFields };
    if (env) {
      serverConfig.env = Object.fromEntries(
        Object.keys(env).map(k => [k, '***'])
      );
    }
    if (headers) {
      serverConfig.headers = Object.fromEntries(
        Object.keys(headers).map(k => [k, '***'])
      );
    }
    const config = {
      mcpServers: {
        [server.id]: serverConfig,
      },
    };
    const jsonContent = JSON.stringify(config, null, 2);
    const success = await copyToClipboard(jsonContent);
    if (success) {
      addToast(t('mcp.configCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  }, [addToast, t]);

  return {
    showServerDialog,
    setShowServerDialog,
    showPresetDialog,
    setShowPresetDialog,
    showMarketplaceDialog,
    setShowMarketplaceDialog,
    showImportDialog,
    setShowImportDialog,
    showHelpDialog,
    setShowHelpDialog,
    showConfirmDialog,
    showLogDialog,
    setShowLogDialog,
    editingServer,
    setEditingServer,
    deletingServer,
    handleEdit,
    handleDelete,
    confirmDelete,
    cancelDelete,
    handleAddManual,
    handleAddFromMarket,
    handleImportFromCopilot,
    handleImportServers,
    handleSaveServer,
    handleSelectPreset,
    handleCopyUrl,
    handleCopyConfig,
  };
}
