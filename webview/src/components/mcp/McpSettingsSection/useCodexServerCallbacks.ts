/**
 * Registers Codex MCP mutation callbacks on window.
 * Codex mutations report success only after config.toml was written.
 */

import { useEffect } from 'react';
import type { McpServer } from '../../../types/mcp';
import type { ToastMessage } from '../../Toast';

export interface UseCodexServerCallbacksOptions {
  isCodexMode: boolean;
  addToast: (message: string, type?: ToastMessage['type']) => void;
  loadServers: () => void;
  loadServerStatus: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useCodexServerCallbacks({
  isCodexMode,
  addToast,
  loadServers,
  loadServerStatus,
  t,
}: UseCodexServerCallbacksOptions): void {
  useEffect(() => {
    if (!isCodexMode) {
      return;
    }
    const readServer = (json: string): McpServer | null => {
      try {
        return JSON.parse(json) as McpServer;
      } catch {
        return null;
      }
    };
    window.codexMcpServerAdded = (json) => {
      const server = readServer(json);
      addToast(`${t('mcp.added')} ${server?.name || server?.id || ''}`, 'success');
      loadServers();
    };
    window.codexMcpServerUpdated = (json) => {
      const server = readServer(json);
      addToast(`${t('mcp.saved')} ${server?.name || server?.id || ''}`, 'success');
      loadServers();
    };
    window.codexMcpServerDeleted = (serverId) => {
      addToast(`${t('mcp.deleted')} ${serverId}`, 'success');
      loadServers();
    };
    window.codexMcpServerToggled = (json) => {
      const server = readServer(json);
      const enabled = server?.enabled !== false;
      addToast(`${enabled ? t('mcp.enabled') : t('mcp.disabled')} ${server?.name || server?.id || ''}`, 'success');
      loadServers();
      loadServerStatus();
    };
    return () => {
      window.codexMcpServerAdded = undefined;
      window.codexMcpServerUpdated = undefined;
      window.codexMcpServerDeleted = undefined;
      window.codexMcpServerToggled = undefined;
    };
  }, [isCodexMode, addToast, loadServers, loadServerStatus, t]);
}
