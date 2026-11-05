/**
 * Dialog visibility state and server action handlers for the MCP settings panel
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { McpServer, McpPreset } from '../../../types/mcp';
import type { CacheKeys, ServerToolsState } from '../types';
import { clearToolsCache } from '../utils';
import { sendToJava } from '../../../utils/bridge';
import { copyToClipboard } from '../../../utils/copyUtils';
import type { ToastMessage } from '../../Toast';

/** Replacement written in place of a redacted secret. */
const REDACTED = '***';

/**
 * Names that mark a flag, an env var, a header or a query parameter as secret-bearing.
 * Deliberately broad: over-masking a harmless value only costs readability in a
 * config snippet the user is about to review, while a missed secret ends up pasted
 * into a chat window, a bug report or a public gist.
 */
const SENSITIVE_KEY_PATTERN = /(api[-_]?key|access[-_]?key|private[-_]?key|secret|token|password|passwd|passphrase|auth|credential|signature|^sig$|session)/i;

/** Value shapes that are a secret no matter which key carries them. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{8,}$/,
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^xox[abopsr]-[A-Za-z0-9-]{8,}$/,
  /^AKIA[0-9A-Z]{12,}$/,
  /^[A-Fa-f0-9]{32,}$/,
  /^[A-Za-z0-9_-]{40,}$/,
];

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Redact secrets passed as command-line arguments.
 * A value is redacted when it follows a secret-looking flag ("--api-key sk-…") or when
 * it looks like a credential on its own.
 */
function redactArgs(args: unknown[]): { args: string[]; redacted: boolean } {
  const out: string[] = [];
  let redacted = false;
  let maskNext = false;

  for (const raw of args) {
    const value = typeof raw === 'string' ? raw : String(raw);
    if (maskNext) {
      out.push(REDACTED);
      redacted = true;
      maskNext = false;
    } else if (value.startsWith('-') && SENSITIVE_KEY_PATTERN.test(value.replace(/^--?/, ''))) {
      out.push(value);
      maskNext = true;
    } else if (looksLikeSecretValue(value)) {
      out.push(REDACTED);
      redacted = true;
    } else {
      out.push(value);
    }
  }

  return { args: out, redacted };
}

/**
 * Redact secrets embedded in a server URL: credentials in the authority
 * ("https://user:pass@host") and secret-looking query parameters
 * ("https://host/mcp?token=…"). A non-absolute URL is returned untouched.
 */
function redactUrl(rawUrl: string): { url: string; redacted: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, redacted: false };
  }

  let redacted = false;
  if (parsed.password) {
    parsed.password = REDACTED;
    redacted = true;
  }

  // Collect the keys first: mutating searchParams while iterating it is fragile.
  for (const key of Array.from(parsed.searchParams.keys())) {
    const value = parsed.searchParams.get(key) ?? '';
    if (SENSITIVE_KEY_PATTERN.test(key) || looksLikeSecretValue(value)) {
      parsed.searchParams.set(key, REDACTED);
      redacted = true;
    }
  }

  return { url: parsed.toString(), redacted };
}

export interface UseServerActionsOptions {
  messagePrefix: string;
  isCodexMode: boolean;
  addToast: (message: string, type?: ToastMessage['type']) => void;
  cacheKeys: CacheKeys;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  loadServers: () => void;
  loadServerStatus: (serverNames?: string[]) => void;
  closeDropdown: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useServerActions({
  messagePrefix,
  isCodexMode,
  addToast,
  cacheKeys,
  setServerTools,
  loadServers,
  loadServerStatus,
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

  // Last server the user approved/rejected, so the success toast raised by the
  // backend callback can use its display name instead of the raw config key.
  const decidedServerRef = useRef<McpServer | null>(null);

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

  // Copy server config (redact sensitive values)
  // env/headers are redacted wholesale; args and URL secrets are redacted selectively,
  // because a project-local server can come from a foreign repository and its command
  // line may carry somebody else's key in plain sight.
  const handleCopyConfig = useCallback(async (server: McpServer) => {
    const { env, headers, args, url, ...safeFields } = server.server;
    const serverConfig: Record<string, unknown> = { ...safeFields };
    let redacted = false;
    if (env) {
      serverConfig.env = Object.fromEntries(
        Object.keys(env).map(k => [k, REDACTED])
      );
    }
    if (headers) {
      serverConfig.headers = Object.fromEntries(
        Object.keys(headers).map(k => [k, REDACTED])
      );
    }
    if (Array.isArray(args)) {
      const result = redactArgs(args);
      serverConfig.args = result.args;
      redacted = redacted || result.redacted;
    }
    if (typeof url === 'string' && url) {
      const result = redactUrl(url);
      serverConfig.url = result.url;
      redacted = redacted || result.redacted;
    }
    const config = {
      mcpServers: {
        [server.id]: serverConfig,
      },
    };
    const jsonContent = JSON.stringify(config, null, 2);
    const success = await copyToClipboard(jsonContent);
    if (success) {
      addToast(redacted ? t('mcp.configCopiedRedacted') : t('mcp.configCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  }, [addToast, t]);

  // Approve a project-local MCP server.
  // The caller must have confirmed the trust grant first (see ServerCardHeader).
  // No success toast here: the backend reports the outcome through
  // window.mcpServerApproved / window.showError, and toasting on send would claim
  // success even when the write to .claude/settings.local.json failed.
  const handleApprove = useCallback((server: McpServer) => {
    decidedServerRef.current = server;
    sendToJava('approve_mcp_json_server', { serverId: server.id });
    // Approving flips the server's effective enabled state, so the previous
    // tools result and connection status are both stale. Mirrors handleToggleServer.
    clearToolsCache(server.id, cacheKeys);
    setServerTools(prev => {
      const next = { ...prev };
      delete next[server.id];
      return next;
    });
    setTimeout(() => {
      loadServers();
      // Only this server changed — re-verifying every other one would spawn their
      // processes / re-hit their endpoints for nothing.
      loadServerStatus([server.id]);
    }, 100);
  }, [cacheKeys, setServerTools, loadServers, loadServerStatus]);

  // Reject a project-local MCP server (no success toast — see handleApprove)
  const handleReject = useCallback((server: McpServer) => {
    decidedServerRef.current = server;
    sendToJava('reject_mcp_json_server', { serverId: server.id });
    clearToolsCache(server.id, cacheKeys);
    setServerTools(prev => {
      const next = { ...prev };
      delete next[server.id];
      return next;
    });
    setTimeout(() => {
      loadServers();
      loadServerStatus([server.id]);
    }, 100);
  }, [cacheKeys, setServerTools, loadServers, loadServerStatus]);

  // Approve/reject outcome, reported by McpServerHandler after the settings file
  // was actually written (failures arrive as window.showError instead).
  useEffect(() => {
    if (isCodexMode) {
      // .mcp.json project trust is a Claude-only concept; the backend never calls
      // these callbacks in Codex mode.
      return;
    }

    const announce = (serverId: string, message: string) => {
      // The backend re-reads the server list itself after a decision, so only the
      // status needs refreshing here — and only for the server that was decided on.
      addToast(`${message} ${decidedServerRef.current?.id === serverId
        ? (decidedServerRef.current?.name || serverId)
        : serverId}`, 'success');
      if (serverId) {
        loadServerStatus([serverId]);
      }
    };

    const handleApproved = (serverId: string) => announce(serverId, t('mcp.approved'));
    const handleRejected = (serverId: string) => announce(serverId, t('mcp.rejected'));

    window.mcpServerApproved = handleApproved;
    window.mcpServerRejected = handleRejected;

    return () => {
      window.mcpServerApproved = undefined;
      window.mcpServerRejected = undefined;
    };
  }, [isCodexMode, addToast, t, loadServerStatus]);

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
    handleApprove,
    handleReject,
  };
}
