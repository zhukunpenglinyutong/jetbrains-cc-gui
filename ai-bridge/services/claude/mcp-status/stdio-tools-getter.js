/**
 * STDIO 工具获取模块
 * 提供从 STDIO 类型 MCP 服务器获取工具列表的功能
 */

import { spawn } from 'child_process';
import { MCP_TOOLS_TIMEOUT, createSafeEnv, STDIO_TOOLS_MAX_LINE_LENGTH } from './config.js';
import { log } from './logger.js';
import { validateCommand } from './command-validator.js';
import { safeKillProcess } from './process-manager.js';
import { MCP_PROTOCOL_VERSION, MCP_CLIENT_INFO } from './mcp-protocol.js';

/**
 * 获取 STDIO 类型服务器的工具列表
 * 实现正确的 MCP STDIO 初始化流程：initialize → initialized → tools/list
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 工具列表响应
 */
export async function getStdioServerTools(serverName, serverConfig) {
  return new Promise((resolve) => {
    let resolved = false;
    let child = null;
    let stderrBuffer = '';

    const result = {
      name: serverName,
      tools: [],
      error: null
    };

    const command = serverConfig.command;
    const args = serverConfig.args || [];
    const env = createSafeEnv(serverConfig.env);

    if (!command) {
      result.error = 'No command specified';
      resolve(result);
      return;
    }

    // 验证命令白名单（仅警告，不阻止）
    const validation = validateCommand(command);
    if (!validation.valid) {
      log('warn', `[MCP Tools] Non-whitelisted command for ${serverName}: ${command} (${validation.reason})`);
      log('info', `[MCP Tools] Proceeding with tools fetch for user-configured server: ${serverName}`);
    }

    log('info', '[MCP Tools] Getting tools for STDIO server:', serverName);
    log('debug', '[MCP Tools] Command:', command, 'Args:', args.length ? args.join(' ') : '(none)');

    // 状态机：0=未初始化, 1=等待initialize响应, 2=已初始化, 3=等待tools/list响应
    const state = {
      step: 0,
      buffer: ''
    };

    const finalize = (tools = null, error = null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      if (tools) result.tools = tools;
      result.error = error;
      if (child) {
        safeKillProcess(child, serverName);
      }
      if (error) {
        log('error', '[MCP Tools] ' + serverName + ' failed:', error);
      } else {
        log('info', '[MCP Tools] ' + serverName + ' completed:', (tools ? tools.length : 0) + ' tools');
      }
      resolve(result);
    };

    // 使用配置的超时时间
    const timeoutId = setTimeout(() => {
      finalize(null, `Timeout after ${MCP_TOOLS_TIMEOUT / 1000}s`);
    }, MCP_TOOLS_TIMEOUT);

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
        log('debug', '[MCP Tools] Using shell for command:', command);
      }

      child = spawn(command, args, spawnOptions);
      log('info', '[MCP Tools] Spawned process PID:', child.pid);
    } catch (spawnError) {
      finalize(null, 'Failed to spawn process: ' + spawnError.message);
      return;
    }

    // 处理 stdout - MCP 协议消息
    child.stdout.on('data', (data) => {
      state.buffer += data.toString();

      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line.length > STDIO_TOOLS_MAX_LINE_LENGTH) continue;

        log('debug', '[MCP Tools] ' + serverName + ' stdout:', line.substring(0, 100));

        try {
          const response = JSON.parse(line);

          // 阶段 1：收到 initialize 响应 (id=1)
          if (state.step === 1 && response.id === 1) {
            if (response.error) {
              finalize(null, 'Initialize error: ' + (response.error.message || JSON.stringify(response.error)));
              return;
            }
            if (response.result) {
              log('info', '[MCP Tools] ' + serverName + ' received initialize response');

              // 发送 initialized 通知
              const initializedNotification = JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
              }) + '\n';
              child.stdin.write(initializedNotification);
              log('debug', '[MCP Tools] ' + serverName + ' sent initialized notification');

              state.step = 2;

              // 立即发送 tools/list 请求
              const toolsListRequest = JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
              }) + '\n';
              log('info', '[MCP Tools] ' + serverName + ' sending tools/list request');
              child.stdin.write(toolsListRequest);
              state.step = 3;
            }
          }
          // 阶段 3：收到 tools/list 响应 (id=2)
          else if (state.step === 3 && response.id === 2) {
            if (response.error) {
              finalize(null, 'Tools/list error: ' + (response.error.message || JSON.stringify(response.error)));
              return;
            }
            if (response.result) {
              if (response.result.tools) {
                log('info', '[MCP Tools] ' + serverName + ' received ' + response.result.tools.length + ' tools');
                finalize(response.result.tools, null);
              } else {
                log('warn', '[MCP Tools] ' + serverName + ' received tools/list without tools array');
                finalize([], null);
              }
              return;
            }
          }
          // 处理其他错误响应
          else if (response.error) {
            finalize(null, 'Server error: ' + (response.error.message || JSON.stringify(response.error)));
            return;
          }
        } catch (parseError) {
          log('debug', '[MCP Tools] ' + serverName + ' skipped unparseable line');
        }
      }
    });

    // 处理 stderr - 用于调试
    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      // 只保留最后 500 字符的错误信息
      if (stderrBuffer.length > 500) {
        stderrBuffer = stderrBuffer.substring(stderrBuffer.length - 500);
      }
    });

    child.on('error', (error) => {
      log('error', '[MCP Tools] ' + serverName + ' process error:', error.message);
      finalize(null, 'Process error: ' + error.message);
    });

    child.on('close', (code) => {
      log('debug', '[MCP Tools] ' + serverName + ' process closed with code:', code);
      if (!resolved) {
        const errorMsg = code !== 0
          ? 'Process exited with code ' + code + (stderrBuffer ? '. stderr: ' + stderrBuffer.substring(0, 200) : '')
          : 'Process closed without response';
        finalize(null, errorMsg);
      }
    });

    // 发送 initialize 请求
    process.nextTick(() => {
      if (child && child.stdin && !child.stdin.destroyed) {
        const initRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: MCP_CLIENT_INFO
          }
        }) + '\n';
        log('info', '[MCP Tools] ' + serverName + ' sending initialize request');
        try {
          child.stdin.write(initRequest);
          state.step = 1;
        } catch (writeError) {
          finalize(null, 'Failed to write initialize request: ' + writeError.message);
        }
      } else {
        finalize(null, 'Failed to initialize stdin');
      }
    });
  });
}
