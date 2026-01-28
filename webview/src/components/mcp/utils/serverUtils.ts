/**
 * MCP 服务器工具函数模块
 * 提供服务器状态查询、图标、颜色等工具函数
 */

import type { McpServer, McpServerStatusInfo } from '../types';

// ============================================================================
// 图标颜色配置
// ============================================================================

/** 服务器图标颜色列表 */
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
// 服务器状态查询函数
// ============================================================================

/**
 * 获取服务器状态信息
 * @param server - 服务器对象
 * @param serverStatus - 服务器状态映射
 * @returns 服务器状态信息或 undefined
 */
export function getServerStatusInfo(
  server: McpServer,
  serverStatus: Map<string, McpServerStatusInfo>
): McpServerStatusInfo | undefined {
  // 尝试多种方式匹配服务器状态
  // 1. 尝试用 id 匹配
  let statusInfo = serverStatus.get(server.id);
  if (statusInfo) return statusInfo;

  // 2. 尝试用 name 匹配
  if (server.name) {
    statusInfo = serverStatus.get(server.name);
    if (statusInfo) return statusInfo;
  }

  // 3. 遍历所有状态，尝试模糊匹配
  for (const [key, value] of serverStatus.entries()) {
    // 不区分大小写比较
    if (key.toLowerCase() === server.id.toLowerCase() ||
        (server.name && key.toLowerCase() === server.name.toLowerCase())) {
      return value;
    }
  }

  return undefined;
}

/**
 * 检查服务器是否启用
 * @param server - 服务器对象
 * @param isCodexMode - 是否为 Codex 模式
 * @returns 是否启用
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
// 状态图标和颜色函数
// ============================================================================

/**
 * 获取状态图标
 * @param server - 服务器对象
 * @param status - 服务器状态
 * @param isCodexMode - 是否为 Codex 模式
 * @returns 图标类名
 */
export function getStatusIcon(
  server: McpServer,
  status: McpServerStatusInfo['status'] | undefined,
  isCodexMode: boolean
): string {
  // 如果服务器被禁用，显示禁用图标
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
 * 获取状态颜色
 * @param server - 服务器对象
 * @param status - 服务器状态
 * @param isCodexMode - 是否为 Codex 模式
 * @returns 颜色值
 */
export function getStatusColor(
  server: McpServer,
  status: McpServerStatusInfo['status'] | undefined,
  isCodexMode: boolean
): string {
  // 如果服务器被禁用，显示灰色
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
 * 获取状态文本
 * @param server - 服务器对象
 * @param status - 服务器状态
 * @param isCodexMode - 是否为 Codex 模式
 * @param t - 翻译函数
 * @returns 状态文本
 */
export function getStatusText(
  server: McpServer,
  status: McpServerStatusInfo['status'] | undefined,
  isCodexMode: boolean,
  t: (key: string) => string
): string {
  // 如果服务器被禁用，显示"已禁用"
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
// 服务器显示工具函数
// ============================================================================

/**
 * 获取服务器图标颜色
 * @param serverId - 服务器 ID
 * @returns 颜色值
 */
export function getIconColor(serverId: string): string {
  let hash = 0;
  for (let i = 0; i < serverId.length; i++) {
    hash = serverId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return iconColors[Math.abs(hash) % iconColors.length];
}

/**
 * 获取服务器首字母
 * @param server - 服务器对象
 * @returns 首字母
 */
export function getServerInitial(server: McpServer): string {
  const name = server.name || server.id;
  return name.charAt(0).toUpperCase();
}

// ============================================================================
// 工具图标函数
// ============================================================================

/**
 * 根据工具名称获取图标
 * @param toolName - 工具名称
 * @returns 图标类名
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
// 输入 Schema 渲染函数
// ============================================================================

/**
 * 渲染 inputSchema 为参数列表（文本版本）
 * @param inputSchema - 输入 Schema
 * @returns 参数列表
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
