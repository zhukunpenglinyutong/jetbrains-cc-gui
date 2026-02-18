/**
 * MCP server status detection service
 * Verifies MCP server connectivity and retrieves tool listings
 *
 * Module structure:
 * - config.js: Configuration constants and security whitelists
 * - logger.js: Logging system
 * - mcp-protocol.js: MCP protocol utility functions
 * - command-validator.js: Command whitelist validation
 * - server-info-parser.js: Server info parsing
 * - process-manager.js: Process management
 * - http-verifier.js: HTTP/Streamable HTTP server verification
 * - sse-verifier.js: SSE transport server verification
 * - stdio-verifier.js: STDIO server verification
 * - config-loader.js: Configuration loading
 * - http-tools-getter.js: HTTP tools retrieval
 * - sse-tools-getter.js: SSE tools retrieval
 * - stdio-tools-getter.js: STDIO tools retrieval
 */

import { log } from './logger.js';
import { loadMcpServersConfig, loadAllMcpServersInfo } from './config-loader.js';
import { verifyHttpServerStatus } from './http-verifier.js';
import { verifySseServerStatus } from './sse-verifier.js';
import { verifyStdioServerStatus } from './stdio-verifier.js';
import { getHttpServerTools } from './http-tools-getter.js';
import { getSseServerTools } from './sse-tools-getter.js';
import { getStdioServerTools } from './stdio-tools-getter.js';

// Re-export config loading functions
export { loadMcpServersConfig, loadAllMcpServersInfo } from './config-loader.js';

/**
 * Verify the connection status of a single MCP server
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Server status info { name, status, serverInfo, error? }
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

  // STDIO transport server
  return verifyStdioServerStatus(serverName, serverConfig);
}

/**
 * Get the connection status of all MCP servers
 * Includes enabled, disabled, and invalid servers so the frontend gets a complete picture
 * @param {string} cwd - Current working directory (used to detect project config)
 * @returns {Promise<Object[]>} List of MCP server statuses
 */
export async function getMcpServersStatus(cwd = null) {
  try {
    const allServers = await loadAllMcpServersInfo(cwd);

    log('info', 'Found', allServers.enabled.length, 'enabled,',
      allServers.disabled.length, 'disabled,',
      allServers.invalid.length, 'invalid MCP servers');

    // Verify all enabled servers in parallel
    const enabledResults = allServers.enabled.length > 0
      ? await Promise.all(
          allServers.enabled.map(({ name, config }) => verifyMcpServerStatus(name, config))
        )
      : [];

    // Generate failed status for disabled servers (with reason)
    const disabledResults = allServers.disabled.map(name => ({
      name,
      status: 'failed',
      error: 'Server is disabled',
    }));

    // Generate failed status for servers with invalid config (with reason)
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
 * Send a tools/list request to a connected MCP server
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Tools list response
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
