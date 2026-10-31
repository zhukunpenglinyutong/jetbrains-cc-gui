/**
 * STDIO server verification module
 * Provides connection status verification for STDIO-based MCP servers
 */

import { spawn } from 'child_process';
import { MCP_STDIO_VERIFY_TIMEOUT, createSafeEnv } from './config.js';
import { log } from './logger.js';
import { validateCommand } from './command-validator.js';
import { safeKillProcess, createProcessHandlers, sendInitializeRequest } from './process-manager.js';
import { prepareStdioLaunch, resolveWindowsCommand } from './process-launcher.js';

/**
 * Verify the connection status of an STDIO-based MCP server
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Server status info { name, status, serverInfo, error? }
 */
export async function verifyStdioServerStatus(serverName, serverConfig) {
  const env = createSafeEnv(serverConfig.env);
  const launch = await resolveWindowsCommand(serverConfig.command, env);
  return new Promise((resolve) => {
    let resolved = false;
    let child = null;

    const result = {
      name: serverName,
      status: 'pending',
      serverInfo: null
    };

    const command = serverConfig.command;
    const args = serverConfig.args || [];

    // Check if a command is specified
    if (!command) {
      result.status = 'failed';
      result.error = 'No command specified';
      resolve(result);
      return;
    }

    // Validate against command whitelist (warn only, don't block)
    const validation = validateCommand(command);
    if (!validation.valid) {
      log('warn', `[MCP Verify] Non-whitelisted command for ${serverName}: ${command} (${validation.reason})`);
      log('info', `[MCP Verify] Proceeding with verification for user-configured server: ${serverName}`);
    }

    log('info', 'Verifying STDIO server:', serverName, 'command:', command);
    log('debug', 'Full command args:', args.length, 'arguments');

    // Finalization handler
    const finalize = (status, serverInfo = null, error = null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      result.status = status;
      result.serverInfo = serverInfo;
      if (error) {
        result.error = error;
      }
      safeKillProcess(child, serverName);
      resolve(result);
    };

    // Set timeout - use the STDIO-specific timeout
    const timeoutId = setTimeout(() => {
      log('debug', `Timeout for ${serverName} after ${MCP_STDIO_VERIFY_TIMEOUT}ms`);
      finalize('pending');
    }, MCP_STDIO_VERIFY_TIMEOUT);

    // Attempt to spawn the process
    try {
      const prepared = prepareStdioLaunch(launch, args);
      const useShell = launch.useShell;

      const spawnOptions = {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: serverConfig.cwd || undefined,
        // Hide the console window on Windows
        windowsHide: true
      };

      if (useShell) {
        spawnOptions.shell = true;
        log('debug', '[MCP Verify] Using shell for command:', command);
      }

      child = spawn(prepared.command, prepared.args, spawnOptions);
    } catch (spawnError) {
      log('debug', `Failed to spawn process for ${serverName}:`, spawnError.message);
      clearTimeout(timeoutId);
      result.status = 'failed';
      result.error = spawnError.message;
      resolve(result);
      return;
    }

    // Create event handlers
    const handlers = createProcessHandlers({
      serverName,
      child,
      finalize
    });

    // Bind event listeners
    child.stdout.on('data', handlers.stdout.onData);
    child.stderr.on('data', handlers.stderr.onData);
    child.on('error', handlers.onError);
    child.on('close', (code) => {
      if (!resolved) {
        handlers.onClose(code);
      }
    });

    // Send the initialize request
    sendInitializeRequest(child, serverName);
  });
}
