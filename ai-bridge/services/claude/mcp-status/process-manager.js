/**
 * Process management module
 * Provides process creation, event handling, and safe termination
 */

import { log } from './logger.js';
import { parseServerInfo } from './server-info-parser.js';
import { hasValidMcpResponse, createInitializeRequest } from './mcp-protocol.js';

/**
 * Safely terminate a child process
 * @param {import('child_process').ChildProcess | null} child - Child process
 * @param {string} serverName - Server name (for logging)
 */
export function safeKillProcess(child, serverName) {
  if (!child) return;

  try {
    if (!child.killed) {
      child.kill('SIGTERM');
      // If SIGTERM doesn't kill it, send SIGKILL after 500ms
      // Use unref() so this timer won't prevent the parent process from exiting
      const killTimer = setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill('SIGKILL');
            log('debug', `Force killed process for ${serverName}`);
          }
        } catch (e) {
          log('debug', `SIGKILL failed for ${serverName}:`, e.message);
        }
      }, 500);
      killTimer.unref();
    }
  } catch (e) {
    log('debug', `Failed to kill process for ${serverName}:`, e.message);
  }
}

/**
 * Create process event handlers
 * @param {Object} context - Context object
 * @param {string} context.serverName - Server name
 * @param {import('child_process').ChildProcess} context.child - Child process
 * @param {Function} context.finalize - Finalization callback
 * @returns {Object} Collection of event handlers
 */
export function createProcessHandlers(context) {
  const { serverName, finalize } = context;
  let stdout = '';
  let stderr = '';

  return {
    stdout: {
      onData: (data) => {
        stdout += data.toString();
        if (hasValidMcpResponse(stdout)) {
          const serverInfo = parseServerInfo(stdout);
          finalize('connected', serverInfo);
        }
      }
    },
    stderr: {
      onData: (data) => {
        stderr += data.toString();
        // Log stderr output for diagnostics
        const stderrLine = data.toString().trim();
        if (stderrLine) {
          log('debug', `[${serverName}] stderr:`, stderrLine.substring(0, 200));
        }
      }
    },
    onError: (error) => {
      log('debug', `Process error for ${serverName}:`, error.message);
      finalize('failed', null, error.message);
    },
    onClose: (code) => {
      if (hasValidMcpResponse(stdout) || stdout.includes('MCP')) {
        finalize('connected', parseServerInfo(stdout));
      } else if (code !== 0) {
        // Build a detailed error message
        let errorDetails = `Process exited with code ${code}`;
        if (stderr) {
          errorDetails += `. stderr: ${stderr.substring(0, 500)}`;
        }
        if (stdout) {
          errorDetails += `. stdout: ${stdout.substring(0, 500)}`;
        }
        finalize('failed', null, errorDetails);
      } else {
        finalize('pending', null, stderr || 'No response from server');
      }
    },
    getStdout: () => stdout,
    getStderr: () => stderr
  };
}

/**
 * Send an initialize request to the child process
 * Caller is responsible for closing stdin when appropriate.
 * @param {import('child_process').ChildProcess} child - Child process
 * @param {string} serverName - Server name
 */
export function sendInitializeRequest(child, serverName) {
  try {
    child.stdin.write(createInitializeRequest());
  } catch (e) {
    log('debug', `Failed to write to stdin for ${serverName}:`, e.message);
  }
}
