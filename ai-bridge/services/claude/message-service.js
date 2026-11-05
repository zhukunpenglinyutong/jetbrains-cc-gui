/**
 * Message sending service module — coordinator.
 *
 * Responsible for sending messages through Claude Agent SDK.
 * Re-exports all public API from focused submodules:
 *   - message-utils.js: SDK init, retry, truncation, error payloads
 *   - permission-mode.js: Unified tool permission policy and PreToolUse hook
 *   - message-session-registry.js: Active session state
 *   - message-sender.js: sendMessage, sendMessageWithAttachments
 *   - message-sender-anthropic.js: sendMessageWithAnthropicSDK
 *   - message-rewind.js: rewindFiles
 */

// Re-export send functions
export { sendMessage, sendMessageWithAttachments } from './message-sender.js';
export { sendMessageWithAnthropicSDK } from './message-sender-anthropic.js';
export { rewindFiles } from './message-rewind.js';

// Re-export session registry functions
export {
  getActiveSessionIds,
  hasActiveSession,
  removeSession,
  registerActiveQueryResult
} from './message-session-registry.js';

// Re-export error payload builder for external consumers
export { buildConfigErrorPayload } from './message-utils.js';

// MCP dependencies
import {
  getMcpServersStatus,
  getMcpServerTools as getMcpServerToolsImpl,
  loadMcpServersConfig
} from './mcp-status/index.js';

// NOTE: getSlashCommands() was removed — slash commands are now resolved
// locally by Java SlashCommandRegistry (no SDK/bridge call needed).

/**
 * Helper: write a single line to stdout and await flush completion.
 * `process.stdout.write` is async when piped (which it always is when invoked
 * via ProcessBuilder). Awaiting the callback guarantees the entire payload—
 * including the trailing newline—has been accepted by the OS pipe buffer
 * before this function returns. This prevents stderr writes (merged via
 * redirectErrorStream(true) on the Java side) from interleaving with large
 * JSON payloads and corrupting them (#MCP_TOOLS_TRUNCATE).
 * @param {string} line - Line to write (should already include trailing \n)
 */
const writeLineAndWait = (line) => new Promise((resolve) => {
  process.stdout.write(line, 'utf8', resolve);
});

/**
 * Get MCP server connection status.
 * Directly validates the actual connection status of each MCP server (via mcp-status-service module).
 * @param {string} [cwd=null] - Working directory (used to detect project-specific MCP configuration)
 * @param {string[]|null} [serverNames=null] - Restrict the check to these server names (optional)
 */
export async function getMcpServerStatus(cwd = null, serverNames = null) {
  try {
    // Use the mcp-status-service module to get status, passing cwd for project-specific config
    const mcpStatus = await getMcpServersStatus(cwd, serverNames);

    // Output with [MCP_SERVER_STATUS] tag for fast identification on the Java side.
    // Also keep a compatible JSON format as fallback.
    await writeLineAndWait('[MCP_SERVER_STATUS]' + JSON.stringify(mcpStatus) + '\n');
  } catch (error) {
    console.error('[GET_MCP_SERVER_STATUS_ERROR]', error.message);
    // Use the tag on error too, so the Java side can identify it quickly
    await writeLineAndWait('[MCP_SERVER_STATUS]' + JSON.stringify([]) + '\n');
  }
}

/**
 * Get the tools list for a specific MCP server.
 * Directly connects to the MCP server and retrieves its available tools (via mcp-status-service module).
 * @param {string} serverId - MCP server ID
 * @param {string} [cwd=null] - Working directory (used to detect project-specific MCP configuration)
 */
export async function getMcpServerTools(serverId, cwd = null) {
  try {
    console.log('[McpTools] Getting tools for MCP server:', serverId);

    // First load server configuration, passing cwd for project-specific config
    const mcpServers = await loadMcpServersConfig(cwd);
    const targetServer = mcpServers.find(s => s.name === serverId);

    if (!targetServer) {
      const errorJson = JSON.stringify({
        success: false,
        serverId,
        error: `Server not found: ${serverId}`
      });
      await writeLineAndWait('[MCP_SERVER_TOOLS]' + errorJson + '\n');
      return;
    }

    // Call mcp-status-service to get the tools list
    const toolsResult = await getMcpServerToolsImpl(serverId, targetServer.config);

    // Output results with a prefix tag for quick identification by the Java backend
    const tools = toolsResult.tools || [];
    const hasError = !!toolsResult.error;
    // success=true means tools are usable; error may still contain warnings
    // success=false only when no tools AND has error (e.g. timeout, connection failure)
    const resultJson = JSON.stringify({
      success: !hasError || tools.length > 0,
      serverId,
      serverName: toolsResult.name,
      tools,
      error: toolsResult.error
    });
    // Await the full flush of the pipe write. Large payloads (>64KB, the
    // default OS pipe buffer on macOS/Linux) are split across multiple
    // uv_write calls. Without awaiting the callback, channel-manager.js
    // proceeds to console.error(stderr) which—since the Java side merges
    // stderr into stdout via redirectErrorStream(true)—interleaves with
    // the in-flight write and corrupts the JSON, producing
    // MalformedJsonException: Unterminated string.
    const outputLine = '[MCP_SERVER_TOOLS]' + resultJson + '\n';
    await writeLineAndWait(outputLine);

  } catch (error) {
    console.error('[GET_MCP_SERVER_TOOLS_ERROR]', error.message);
    const errorJson = JSON.stringify({
      success: false,
      serverId,
      error: error.message,
      tools: []
    });
    await writeLineAndWait('[MCP_SERVER_TOOLS]' + errorJson + '\n');
  }
}
