/**
 * MCP 服务器状态检测服务
 * 负责验证 MCP 服务器的真实连接状态
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const MCP_VERIFY_TIMEOUT = 8000; // 8 秒超时

/**
 * 安全地终止子进程
 * @param {ChildProcess} child - 子进程
 */
function safeKillProcess(child) {
  try {
    child.kill();
  } catch {
    // 进程可能已退出，忽略 kill 错误
  }
}

/**
 * 从 stdout 解析服务器信息
 * @param {string} stdout - 标准输出内容
 * @returns {Object|null} 服务器信息或 null
 */
function parseServerInfo(stdout) {
  try {
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('"serverInfo"')) {
        const jsonMatch = line.match(/\{.*"serverInfo".*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.result && parsed.result.serverInfo) {
            return parsed.result.serverInfo;
          }
        }
      }
    }
  } catch {
    // JSON 解析失败，返回 null
  }
  return null;
}

/**
 * 创建 MCP initialize 请求
 * @returns {string} JSON-RPC 格式的初始化请求
 */
function createInitializeRequest() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codemoss-ide', version: '1.0.0' }
    }
  }) + '\n';
}

/**
 * 检查输出是否包含有效的 MCP 协议响应
 * @param {string} stdout - 标准输出
 * @returns {boolean}
 */
function hasValidMcpResponse(stdout) {
  return stdout.includes('"jsonrpc"') || stdout.includes('"result"');
}

/**
 * 验证单个 MCP 服务器的连接状态
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息 { name, status, serverInfo }
 */
export async function verifyMcpServerStatus(serverName, serverConfig) {
  return new Promise((resolve) => {
    let resolved = false;

    const result = {
      name: serverName,
      status: 'pending',
      serverInfo: null
    };

    const command = serverConfig.command;
    const args = serverConfig.args || [];
    const env = { ...process.env, ...(serverConfig.env || {}) };

    if (!command) {
      result.status = 'failed';
      resolve(result);
      return;
    }

    console.log('[McpStatus] Verifying server:', serverName, 'command:', command, args.join(' '));

    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (spawnError) {
      console.log('[McpStatus] Failed to spawn process for', serverName, ':', spawnError.message);
      result.status = 'failed';
      resolve(result);
      return;
    }

    const finalize = (status, serverInfo = null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      result.status = status;
      result.serverInfo = serverInfo;
      safeKillProcess(child);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finalize('pending');
    }, MCP_VERIFY_TIMEOUT);

    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (hasValidMcpResponse(stdout) && !resolved) {
        const serverInfo = parseServerInfo(stdout);
        finalize('connected', serverInfo);
      }
    });

    child.stderr.on('data', () => {
      // 收集 stderr 但不使用，避免缓冲区满导致进程阻塞
    });

    child.on('error', (error) => {
      console.log('[McpStatus] Process error for', serverName, ':', error.message);
      finalize('failed');
    });

    child.on('close', (code) => {
      if (resolved) return;

      if (hasValidMcpResponse(stdout) || stdout.includes('MCP')) {
        finalize('connected', parseServerInfo(stdout));
      } else if (code !== 0) {
        finalize('failed');
      } else {
        finalize('pending');
      }
    });

    // 发送 MCP initialize 请求
    try {
      child.stdin.write(createInitializeRequest());
      child.stdin.end();
    } catch {
      console.log('[McpStatus] Failed to write to stdin for', serverName);
    }
  });
}

/**
 * 从 ~/.claude.json 读取 MCP 服务器配置
 * @returns {Promise<Array<{name: string, config: Object}>>} 启用的 MCP 服务器列表
 */
export async function loadMcpServersConfig() {
  try {
    const claudeJsonPath = join(homedir(), '.claude.json');

    if (!existsSync(claudeJsonPath)) {
      console.log('[McpStatus] ~/.claude.json not found');
      return [];
    }

    const content = await readFile(claudeJsonPath, 'utf8');
    const config = JSON.parse(content);

    const mcpServers = config.mcpServers || {};
    const disabledServers = new Set(config.disabledMcpServers || []);

    const enabledServers = [];
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if (!disabledServers.has(serverName)) {
        enabledServers.push({ name: serverName, config: serverConfig });
      }
    }

    return enabledServers;
  } catch (error) {
    console.error('[McpStatus] Failed to load MCP servers config:', error.message);
    return [];
  }
}

/**
 * 获取所有 MCP 服务器的连接状态
 * @returns {Promise<Object[]>} MCP 服务器状态列表
 */
export async function getMcpServersStatus() {
  try {
    const enabledServers = await loadMcpServersConfig();

    console.log('[McpStatus] Found', enabledServers.length, 'enabled MCP servers, verifying...');

    // 并行验证所有服务器
    const results = await Promise.all(
      enabledServers.map(({ name, config }) => verifyMcpServerStatus(name, config))
    );

    return results;
  } catch (error) {
    console.error('[McpStatus] Failed to get MCP servers status:', error.message);
    return [];
  }
}
