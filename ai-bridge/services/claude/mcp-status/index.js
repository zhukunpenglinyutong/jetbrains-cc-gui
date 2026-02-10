/**
 * MCP 服务器状态检测服务
 * 负责验证 MCP 服务器的真实连接状态和获取工具列表
 *
 * 模块结构：
 * - config.js: 配置常量和安全白名单
 * - logger.js: 日志系统
 * - mcp-protocol.js: MCP 协议工具函数
 * - command-validator.js: 命令白名单验证
 * - server-info-parser.js: 服务器信息解析
 * - process-manager.js: 进程管理
 * - http-verifier.js: HTTP/Streamable HTTP 服务器验证
 * - sse-verifier.js: SSE 传输服务器验证
 * - stdio-verifier.js: STDIO 服务器验证
 * - config-loader.js: 配置加载
 * - http-tools-getter.js: HTTP 工具获取
 * - sse-tools-getter.js: SSE 工具获取
 * - stdio-tools-getter.js: STDIO 工具获取
 */

import { log } from './logger.js';
import { loadMcpServersConfig, loadAllMcpServersInfo } from './config-loader.js';
import { verifyHttpServerStatus } from './http-verifier.js';
import { verifySseServerStatus } from './sse-verifier.js';
import { verifyStdioServerStatus } from './stdio-verifier.js';
import { getHttpServerTools } from './http-tools-getter.js';
import { getSseServerTools } from './sse-tools-getter.js';
import { getStdioServerTools } from './stdio-tools-getter.js';

// 重新导出配置加载函数
export { loadMcpServersConfig, loadAllMcpServersInfo } from './config-loader.js';

/**
 * 验证单个 MCP 服务器的连接状态
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息 { name, status, serverInfo, error? }
 */
export async function verifyMcpServerStatus(serverName, serverConfig) {
  const serverType = serverConfig.type || 'stdio';

  // SSE transport uses a different handshake (GET stream → endpoint discovery → POST)
  if (serverType === 'sse') {
    return verifySseServerStatus(serverName, serverConfig);
  }

  // Streamable HTTP / generic HTTP use direct POST
  if (serverType === 'http' || serverType === 'streamable-http') {
    return verifyHttpServerStatus(serverName, serverConfig);
  }

  // STDIO 类型服务器
  return verifyStdioServerStatus(serverName, serverConfig);
}

/**
 * 获取所有 MCP 服务器的连接状态
 * 包含启用、禁用和配置无效的服务器，确保前端能获取完整状态
 * @param {string} cwd - 当前工作目录（用于检测项目配置）
 * @returns {Promise<Object[]>} MCP 服务器状态列表
 */
export async function getMcpServersStatus(cwd = null) {
  try {
    const allServers = await loadAllMcpServersInfo(cwd);

    log('info', 'Found', allServers.enabled.length, 'enabled,',
      allServers.disabled.length, 'disabled,',
      allServers.invalid.length, 'invalid MCP servers');

    // 并行验证所有启用的服务器
    const enabledResults = allServers.enabled.length > 0
      ? await Promise.all(
          allServers.enabled.map(({ name, config }) => verifyMcpServerStatus(name, config))
        )
      : [];

    // 为禁用的服务器生成 failed 状态（附带原因）
    const disabledResults = allServers.disabled.map(name => ({
      name,
      status: 'failed',
      error: 'Server is disabled',
    }));

    // 为配置无效的服务器生成 failed 状态（附带原因）
    const invalidResults = allServers.invalid.map(({ name, reason }) => ({
      name,
      status: 'failed',
      error: `Invalid config: ${reason}`,
    }));

    const results = [...enabledResults, ...disabledResults, ...invalidResults];

    log('info', '[MCP Status] Completed: total', results.length, 'servers (',
      enabledResults.length, 'verified,',
      disabledResults.length, 'disabled,',
      invalidResults.length, 'invalid)');

    return results;
  } catch (error) {
    log('error', 'Failed to get MCP servers status:', error.message);
    return [];
  }
}

/**
 * 发送 tools/list 请求到已连接的 MCP 服务器
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 工具列表响应
 */
export async function getMcpServerTools(serverName, serverConfig) {
  const serverType = serverConfig.type || 'stdio';

  // SSE transport uses endpoint discovery before sending requests
  if (serverType === 'sse') {
    return getSseServerTools(serverName, serverConfig);
  }

  // Streamable HTTP / generic HTTP use direct POST
  if (serverType === 'http' || serverType === 'streamable-http') {
    return getHttpServerTools(serverName, serverConfig);
  }

  return getStdioServerTools(serverName, serverConfig);
}
