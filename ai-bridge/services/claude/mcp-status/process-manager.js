/**
 * 进程管理模块
 * 提供进程创建、事件处理和安全终止功能
 */

import { log } from './logger.js';
import { parseServerInfo } from './server-info-parser.js';
import { hasValidMcpResponse, createInitializeRequest } from './mcp-protocol.js';

/**
 * 安全地终止子进程
 * @param {import('child_process').ChildProcess | null} child - 子进程
 * @param {string} serverName - 服务器名称（用于日志）
 */
export function safeKillProcess(child, serverName) {
  if (!child) return;

  try {
    if (!child.killed) {
      child.kill('SIGTERM');
      // 如果 SIGTERM 没有终止进程，500ms 后发送 SIGKILL
      // 使用 unref() 确保此定时器不会阻止父进程退出
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
 * 创建进程事件处理器
 * @param {Object} context - 上下文对象
 * @param {string} context.serverName - 服务器名称
 * @param {import('child_process').ChildProcess} context.child - 子进程
 * @param {Function} context.finalize - 完成回调
 * @returns {Object} 事件处理器集合
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
        // 记录 stderr 输出用于诊断
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
        // 构建详细的错误信息
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
 * 发送初始化请求到子进程
 * Caller is responsible for closing stdin when appropriate.
 * @param {import('child_process').ChildProcess} child - 子进程
 * @param {string} serverName - 服务器名称
 */
export function sendInitializeRequest(child, serverName) {
  try {
    child.stdin.write(createInitializeRequest());
  } catch (e) {
    log('debug', `Failed to write to stdin for ${serverName}:`, e.message);
  }
}
