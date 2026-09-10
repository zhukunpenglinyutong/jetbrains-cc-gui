/**
 * MCP Server Settings Component
 * Supports both Claude and Codex modes
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ToastContainer } from '../Toast';

// Types and utility functions
import type { McpSettingsSectionProps, McpTool } from './types';
import { getCacheKeys } from './utils';

// Hooks
import { useServerData } from './hooks/useServerData';
import { useServerManagement } from './hooks/useServerManagement';
import { useToolsUpdate } from './hooks/useToolsUpdate';
import { useFeedback } from './McpSettingsSection/useFeedback';
import { useServerActions } from './McpSettingsSection/useServerActions';
import { useCodexServerCallbacks } from './McpSettingsSection/useCodexServerCallbacks';

// Sub-components
import { McpHeader } from './McpSettingsSection/McpHeader';
import { McpServerList } from './McpSettingsSection/McpServerList';
import { McpDialogs } from './McpSettingsSection/McpDialogs';
import { McpToolTooltip, type HoveredToolState } from './McpSettingsSection/McpToolTooltip';
import { getMcpMessagePrefix, resolveInitialMcpProvider, type McpProvider } from './providerSelection';

/**
 * MCP Server Settings Component
 */
export function McpSettingsSection({ currentProvider = 'claude' }: McpSettingsSectionProps) {
  const [selectedProvider, setSelectedProvider] = useState<McpProvider>(() => {
    let savedProvider: string | null = null;
    try {
      savedProvider = localStorage.getItem('mcp.selectedProvider');
    } catch {
      // Fall back to the active chat provider when storage is unavailable.
    }
    return resolveInitialMcpProvider(currentProvider, savedProvider);
  });

  const selectProvider = useCallback((provider: McpProvider) => {
    setSelectedProvider(provider);
    try {
      localStorage.setItem('mcp.selectedProvider', provider);
    } catch {
      // The selection remains valid for this settings session.
    }
  }, []);

  return (
    <div className="mcp-settings-shell">
      <div className="mcp-provider-tabs" role="tablist" aria-label="MCP provider">
        <button
          type="button"
          role="tab"
          aria-selected={selectedProvider === 'claude'}
          className={selectedProvider === 'claude' ? 'active' : ''}
          onClick={() => selectProvider('claude')}
        >
          <span className="codicon codicon-hubot" aria-hidden="true" />
          Claude
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={selectedProvider === 'codex'}
          className={selectedProvider === 'codex' ? 'active' : ''}
          onClick={() => selectProvider('codex')}
        >
          <span className="codicon codicon-terminal" aria-hidden="true" />
          Codex
        </button>
      </div>
      <McpProviderPanel key={selectedProvider} currentProvider={selectedProvider} />
    </div>
  );
}

function McpProviderPanel({ currentProvider }: { currentProvider: McpProvider }) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';

  // Generate message type prefix based on provider
  const messagePrefix = useMemo(() => getMcpMessagePrefix(currentProvider), [currentProvider]);

  // Get provider-specific cache keys
  const cacheKeys = useMemo(() => getCacheKeys(isCodexMode ? 'codex' : 'claude'), [isCodexMode]);

  // Dropdown menu state
  const [showDropdown, setShowDropdown] = useState(false);
  const closeDropdown = useCallback(() => setShowDropdown(false), []);

  // Tool tooltip popup state
  const [hoveredTool, setHoveredTool] = useState<HoveredToolState | null>(null);

  // Toast notifications and refresh logs
  const { toasts, refreshLogs, addToast, dismissToast, addLog, clearLogs } = useFeedback({ t });

  // Use server data hook
  const {
    servers,
    serverStatus,
    loading,
    statusLoading,
    expandedServers,
    serverTools,
    setServerTools,
    setExpandedServers,
    loadServers,
    loadServerStatus,
    loadServerTools,
  } = useServerData({
    isCodexMode,
    messagePrefix,
    cacheKeys,
    t,
    onLog: addLog,
  });

  // Use server management hook
  const {
    serverRefreshStates,
    handleRefresh,
    handleRefreshSingleServer,
    handleToggleServer,
  } = useServerManagement({
    isCodexMode,
    messagePrefix,
    cacheKeys,
    setServerTools,
    loadServers,
    loadServerStatus,
    loadServerTools,
    onLog: addLog,
    onToast: addToast,
    t,
  });

  // Use tools list update hook
  useToolsUpdate({
    isCodexMode,
    cacheKeys,
    setServerTools,
    onLog: addLog,
  });

  // Codex mutations report success only after config.toml was written.
  useCodexServerCallbacks({
    isCodexMode,
    addToast,
    loadServers,
    loadServerStatus,
    t,
  });

  // Dialog visibility state and server action handlers
  const {
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
  } = useServerActions({
    messagePrefix,
    isCodexMode,
    addToast,
    loadServers,
    closeDropdown,
    t,
  });

  // Toggle server expand/collapse
  const toggleExpand = useCallback((serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    const isExpanding = !expandedServers.has(serverId);

    if (isExpanding) {
      setExpandedServers(new Set([serverId]));
      // Save last expanded server ID to cache
      try {
        localStorage.setItem(cacheKeys.LAST_SERVER_ID, serverId);
      } catch (e) {
        // ignore
      }

      // Automatically load tool list when expanded.
      if (server && !serverTools[serverId]) {
        loadServerTools(server, false);
      }
    } else {
      const newExpanded = new Set(expandedServers);
      newExpanded.delete(serverId);
      setExpandedServers(newExpanded);
    }
  }, [servers, expandedServers, serverTools, cacheKeys, setExpandedServers, loadServerTools]);

  // Tool hover handler
  const handleToolHover = useCallback((tool: McpTool | null, position?: { x: number; y: number }, serverId?: string) => {
    if (tool && position && serverId) {
      setHoveredTool({ serverId, tool, position });
    } else {
      setHoveredTool(null);
    }
  }, []);

  return (
    <div className="mcp-settings-section">
      {/* Header */}
      <McpHeader
        t={t}
        logCount={refreshLogs.length}
        loading={loading}
        statusLoading={statusLoading}
        showDropdown={showDropdown}
        onToggleDropdown={() => setShowDropdown(!showDropdown)}
        onShowHelp={() => setShowHelpDialog(true)}
        onShowLog={() => setShowLogDialog(true)}
        onRefresh={handleRefresh}
        onAddManual={handleAddManual}
        onAddFromMarket={handleAddFromMarket}
        onImportFromCopilot={handleImportFromCopilot}
      />

      {/* Vertical layout: server list | refresh logs */}
      <McpServerList
        servers={servers}
        loading={loading}
        expandedServers={expandedServers}
        isCodexMode={isCodexMode}
        serverStatus={serverStatus}
        serverRefreshStates={serverRefreshStates}
        serverTools={serverTools}
        t={t}
        onToggleExpand={toggleExpand}
        onToggleServer={handleToggleServer}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onCopyConfig={handleCopyConfig}
        onRefreshServer={handleRefreshSingleServer}
        onLoadTools={loadServerTools}
        onCopyUrl={handleCopyUrl}
        onToolHover={handleToolHover}
      />

      {/* Dialogs */}
      <McpDialogs
        currentProvider={currentProvider}
        existingIds={servers.map(s => s.id)}
        showServerDialog={showServerDialog}
        editingServer={editingServer}
        onCloseServerDialog={() => {
          setShowServerDialog(false);
          setEditingServer(null);
        }}
        onSaveServer={handleSaveServer}
        showPresetDialog={showPresetDialog}
        onClosePresetDialog={() => setShowPresetDialog(false)}
        onSelectPreset={handleSelectPreset}
        showMarketplaceDialog={showMarketplaceDialog}
        onCloseMarketplaceDialog={() => setShowMarketplaceDialog(false)}
        showImportDialog={showImportDialog}
        onCloseImportDialog={() => setShowImportDialog(false)}
        onImportServers={handleImportServers}
        showHelpDialog={showHelpDialog}
        onCloseHelpDialog={() => setShowHelpDialog(false)}
        showConfirmDialog={showConfirmDialog}
        deletingServer={deletingServer}
        onConfirmDelete={confirmDelete}
        onCancelDelete={cancelDelete}
        showLogDialog={showLogDialog}
        refreshLogs={refreshLogs}
        onCloseLogDialog={() => setShowLogDialog(false)}
        onClearLogs={clearLogs}
        t={t}
      />

      {/* Toast notifications */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />

      {/* Tool tooltip popup */}
      <McpToolTooltip hoveredTool={hoveredTool} t={t} />
    </div>
  );
}
