/**
 * MCP server utility functions module
 * Provides utility functions for server status queries, icons, colors, etc.
 */

import type { McpServer, McpServerStatusInfo } from '../types';

// ============================================================================
// Icon color configuration
// ============================================================================

/** Server icon color list */
export const iconColors = [
  '#3B82F6', // blue
  '#10B981', // green
  '#8B5CF6', // purple
  '#F59E0B', // amber
  '#EF4444', // red
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#6366F1', // indigo
];

// ============================================================================
// Server status query functions
// ============================================================================

/**
 * Get server status info
 * @param server - Server object
 * @param serverStatus - Server status map
 * @returns Server status info or undefined
 */
export function getServerStatusInfo(
  server: McpServer,
  serverStatus: Map<string, McpServerStatusInfo>
): McpServerStatusInfo | undefined {
  // Try multiple approaches to match server status
  // 1. Try matching by id
  let statusInfo = serverStatus.get(server.id);
  if (statusInfo) return statusInfo;

  // 2. Try matching by name
  if (server.name) {
    statusInfo = serverStatus.get(server.name);
    if (statusInfo) return statusInfo;
  }

  // 3. Iterate all statuses and try case-insensitive matching
  for (const [key, value] of serverStatus.entries()) {
    // Case-insensitive comparison
    if (key.toLowerCase() === server.id.toLowerCase() ||
        (server.name && key.toLowerCase() === server.name.toLowerCase())) {
      return value;
    }
  }

  return undefined;
}

/**
 * Check whether the server is enabled
 * @param server - Server object
 * @param isCodexMode - Whether in Codex mode
 * @returns Whether enabled
 */
export function isServerEnabled(server: McpServer, isCodexMode: boolean): boolean {
  if (server.enabled !== undefined) {
    return server.enabled;
  }
  // Check provider-specific apps field
  return isCodexMode
    ? server.apps?.codex !== false
    : server.apps?.claude !== false;
}

// ============================================================================
// Status icon and color functions
// ============================================================================

/**
 * Get the status icon
 * @param server - Server object
 * @param status - Server status
 * @param isCodexMode - Whether in Codex mode
 * @returns Icon class name
 */
export function getStatusIcon(
  server: McpServer,
  status: McpServerStatusInfo['status'] | undefined,
  isCodexMode: boolean
): string {
  // Show disabled icon if the server is disabled
  if (!isServerEnabled(server, isCodexMode)) {
    return 'codicon-circle-slash';
  }

  switch (status) {
    case 'connected':
      return 'codicon-check';
    case 'failed':
      return 'codicon-error';
    case 'needs-auth':
      return 'codicon-key';
    case 'pending':
      return 'codicon-loading codicon-modifier-spin';
    default:
      return 'codicon-circle-outline';
  }
}

/**
 * Get the status color
 * @param server - Server object
 * @param status - Server status
 * @param isCodexMode - Whether in Codex mode
 * @returns Color value
 */
export function getStatusColor(
  server: McpServer,
  status: McpServerStatusInfo['status'] | undefined,
  isCodexMode: boolean
): string {
  // Show gray if the server is disabled
  if (!isServerEnabled(server, isCodexMode)) {
    return '#9CA3AF';
  }

  switch (status) {
    case 'connected':
      return '#10B981';
    case 'failed':
      return '#EF4444';
    case 'needs-auth':
      return '#F59E0B';
    case 'pending':
      return '#6B7280';
    default:
      return '#6B7280';
  }
}

/**
 * Get the status text
 * @param server - Server object
 * @param status - Server status
 * @param isCodexMode - Whether in Codex mode
 * @param t - Translation function
 * @returns Status text
 */
export function getStatusText(
  server: McpServer,
  status: McpServerStatusInfo['status'] | undefined,
  isCodexMode: boolean,
  t: (key: string) => string
): string {
  // Show "Disabled" if the server is disabled
  if (!isServerEnabled(server, isCodexMode)) {
    return t('mcp.disabled');
  }

  switch (status) {
    case 'connected':
      return t('mcp.statusConnected');
    case 'failed':
      return t('mcp.statusFailed');
    case 'needs-auth':
      return t('mcp.statusNeedsAuth');
    case 'pending':
      return t('mcp.statusPending');
    default:
      return t('mcp.statusUnknown');
  }
}

// ============================================================================
// Server display utility functions
// ============================================================================

/**
 * Get the server icon color
 * @param serverId - Server ID
 * @returns Color value
 */
export function getIconColor(serverId: string): string {
  let hash = 0;
  for (let i = 0; i < serverId.length; i++) {
    hash = serverId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return iconColors[Math.abs(hash) % iconColors.length];
}

/**
 * Get the server initial letter
 * @param server - Server object
 * @returns Initial letter
 */
export function getServerInitial(server: McpServer): string {
  const name = server.name || server.id;
  return name.charAt(0).toUpperCase();
}

// ============================================================================
// Tool icon functions
// ============================================================================

/**
 * Get the icon based on tool name
 * @param toolName - Tool name
 * @returns Icon class name
 */
export function getToolIcon(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes('search') || name.includes('query') || name.includes('find')) {
    return 'codicon-search';
  }
  if (name.includes('read') || name.includes('get') || name.includes('fetch')) {
    return 'codicon-file-text';
  }
  if (name.includes('write') || name.includes('create') || name.includes('add') || name.includes('insert')) {
    return 'codicon-edit';
  }
  if (name.includes('delete') || name.includes('remove')) {
    return 'codicon-trash';
  }
  if (name.includes('update') || name.includes('modify') || name.includes('change')) {
    return 'codicon-sync';
  }
  if (name.includes('list') || name.includes('all')) {
    return 'codicon-list-tree';
  }
  if (name.includes('execute') || name.includes('run') || name.includes('call')) {
    return 'codicon-play';
  }
  if (name.includes('connect')) {
    return 'codicon-plug';
  }
  if (name.includes('send') || name.includes('post')) {
    return 'codicon-mail';
  }
  if (name.includes('parse') || name.includes('analyze')) {
    return 'codicon-symbol-misc';
  }
  return 'codicon-symbol-property';
}

// ============================================================================
// Input schema rendering functions
// ============================================================================

/**
 * Render inputSchema as a parameter list (text version)
 * @param inputSchema - Input schema
 * @returns Parameter list
 */
export function renderInputSchemaText(
  inputSchema: Record<string, unknown> | undefined
): { name: string; type: string; description: string; required: boolean }[] {
  if (!inputSchema) {
    return [];
  }

  const properties = inputSchema.properties as Record<string, { type?: string; description?: string }> | undefined;
  const required = (inputSchema.required as string[]) || [];

  if (!properties || Object.keys(properties).length === 0) {
    return [];
  }

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: prop.type || 'unknown',
    description: prop.description || '',
    required: required.includes(name),
  }));
}
