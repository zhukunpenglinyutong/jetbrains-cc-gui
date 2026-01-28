/**
 * STDIO 服务器验证模块
 * 提供 STDIO 类型 MCP 服务器的连接状态验证功能
 */

import { spawn } from 'child_process';
import { MCP_STDIO_VERIFY_TIMEOUT, createSafeEnv } from './config.js';
import { log } from './logger.js';
import { validateCommand } from './command-validator.js';
import { safeKillProcess, createProcessHandlers, sendInitializeRequest } from './process-manager.js';

/**
 * 验证 STDIO 类型 MCP 服务器的连接状态
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息 { name, status, serverInfo, error? }
 */
export async function verifyStdioServerStatus(serverName, serverConfig) {
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
    const env = createSafeEnv(serverConfig.env);

    // 检查命令是否存在
    if (!command) {
      result.status = 'failed';
      result.error = 'No command specified';
      resolve(result);
      return;
    }

    // 验证命令白名单
    const validation = validateCommand(command);
    if (!validation.valid) {
      log('warn', `Blocked command for ${serverName}: ${validation.reason}`);
      result.status = 'failed';
      result.error = validation.reason;
      resolve(result);
      return;
    }

    log('info', 'Verifying STDIO server:', serverName, 'command:', command);
    log('debug', 'Full command args:', args.length, 'arguments');

    // 完成处理函数
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

    // 设置超时 - 使用 STDIO 专用超时
    const timeoutId = setTimeout(() => {
      log('debug', `Timeout for ${serverName} after ${MCP_STDIO_VERIFY_TIMEOUT}ms`);
      finalize('pending');
    }, MCP_STDIO_VERIFY_TIMEOUT);

    // 尝试启动进程
    try {
      // Windows 下某些命令需要使用 shell
      const useShell = process.platform === 'win32' &&
                      (command.endsWith('.cmd') || command.endsWith('.bat') ||
                       command === 'npx' || command === 'npm' ||
                       command === 'pnpm' || command === 'yarn');

      const spawnOptions = {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows 下隐藏命令行窗口
        windowsHide: true
      };

      if (useShell) {
        spawnOptions.shell = true;
        log('debug', '[MCP Verify] Using shell for command:', command);
      }

      child = spawn(command, args, spawnOptions);
    } catch (spawnError) {
      log('debug', `Failed to spawn process for ${serverName}:`, spawnError.message);
      clearTimeout(timeoutId);
      result.status = 'failed';
      result.error = spawnError.message;
      resolve(result);
      return;
    }

    // 创建事件处理器
    const handlers = createProcessHandlers({
      serverName,
      child,
      finalize
    });

    // 绑定事件
    child.stdout.on('data', handlers.stdout.onData);
    child.stderr.on('data', handlers.stderr.onData);
    child.on('error', handlers.onError);
    child.on('close', (code) => {
      if (!resolved) {
        handlers.onClose(code);
      }
    });

    // 发送初始化请求
    sendInitializeRequest(child, serverName);
  });
}
