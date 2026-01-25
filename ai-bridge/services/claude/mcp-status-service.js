/**
 * MCP 服务器状态检测服务
 * 负责验证 MCP 服务器的真实连接状态
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================================
// 配置常量
// ============================================================================

/** 验证超时时间（毫秒），可通过环境变量配置 */
const MCP_VERIFY_TIMEOUT = parseInt(process.env.MCP_VERIFY_TIMEOUT) || 8000;

/** 是否启用调试日志 */
const DEBUG = process.env.MCP_DEBUG === 'true' || process.env.DEBUG === 'true';

/**
 * 允许执行的命令白名单
 * 只允许常见的 MCP 服务器启动命令，防止任意命令执行
 */
const ALLOWED_COMMANDS = new Set([
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bunx',
  'bun',
  'python',
  'python3',
  'uvx',
  'uv',
  'deno',
  'docker',
  'cargo',
  'go',
]);

/**
 * 允许的可执行文件扩展名（Windows）
 */
const VALID_EXTENSIONS = new Set(['', '.exe', '.cmd', '.bat']);

/** 最大输出行长度限制（防止 ReDoS 攻击） */
const MAX_LINE_LENGTH = 10000;

// ============================================================================
// 日志工具
// ============================================================================

/**
 * 统一的日志输出函数
 * @param {'info' | 'debug' | 'error' | 'warn'} level - 日志级别
 * @param  {...any} args - 日志参数
 */
function log(level, ...args) {
  const prefix = '[McpStatus]';
  switch (level) {
    case 'debug':
      if (DEBUG) {
        console.log(prefix, '[DEBUG]', ...args);
      }
      break;
    case 'error':
      console.error(prefix, '[ERROR]', ...args);
      break;
    case 'warn':
      console.warn(prefix, '[WARN]', ...args);
      break;
    case 'info':
    default:
      console.log(prefix, ...args);
      break;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 验证命令是否在白名单中
 * @param {string} command - 要验证的命令
 * @returns {{ valid: boolean, reason?: string }} 验证结果
 */
function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    return { valid: false, reason: 'Command is empty or invalid' };
  }

  // 提取基础命令名（去除路径）
  const baseCommand = command.split('/').pop().split('\\').pop();

  // 检查是否在白名单中（完全匹配）
  if (ALLOWED_COMMANDS.has(baseCommand)) {
    return { valid: true };
  }

  // 检查是否是带扩展名的白名单命令（如 node.exe）
  // 提取扩展名并验证
  const lastDotIndex = baseCommand.lastIndexOf('.');
  if (lastDotIndex > 0) {
    const nameWithoutExt = baseCommand.substring(0, lastDotIndex);
    const ext = baseCommand.substring(lastDotIndex).toLowerCase();

    // 验证扩展名是否在允许列表中
    if (!VALID_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        reason: `Invalid command extension "${ext}". Allowed extensions: ${[...VALID_EXTENSIONS].filter(e => e).join(', ')}`
      };
    }

    // 验证基础命令名是否在白名单中
    if (ALLOWED_COMMANDS.has(nameWithoutExt)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: `Command "${baseCommand}" is not in the allowed list. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`
  };
}

/**
 * 安全地终止子进程
 * @param {import('child_process').ChildProcess | null} child - 子进程
 * @param {string} serverName - 服务器名称（用于日志）
 */
function safeKillProcess(child, serverName) {
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
 * 从 stdout 解析服务器信息
 * @param {string} stdout - 标准输出内容
 * @returns {Object|null} 服务器信息或 null
 */
function parseServerInfo(stdout) {
  try {
    const lines = stdout.split('\n');
    for (const line of lines) {
      // 跳过过长的行以防止 ReDoS 攻击
      if (line.length > MAX_LINE_LENGTH) {
        log('debug', 'Skipping oversized line in parseServerInfo');
        continue;
      }

      if (line.includes('"serverInfo"')) {
        // 使用更安全的 JSON 解析方式：找到 JSON 对象边界
        const startIdx = line.indexOf('{');
        if (startIdx === -1) continue;

        // 简单的括号匹配来找到完整的 JSON 对象
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < line.length; i++) {
          if (line[i] === '{') depth++;
          else if (line[i] === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i + 1;
              break;
            }
          }
        }

        if (endIdx > startIdx) {
          const jsonStr = line.substring(startIdx, endIdx);
          const parsed = JSON.parse(jsonStr);
          if (parsed.result && parsed.result.serverInfo) {
            return parsed.result.serverInfo;
          }
        }
      }
    }
  } catch (e) {
    log('debug', 'Failed to parse server info:', e.message);
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

// ============================================================================
// 进程管理
// ============================================================================

/**
 * 创建进程事件处理器
 * @param {Object} context - 上下文对象
 * @param {string} context.serverName - 服务器名称
 * @param {import('child_process').ChildProcess} context.child - 子进程
 * @param {Function} context.finalize - 完成回调
 * @returns {Object} 事件处理器集合
 */
function createProcessHandlers(context) {
  const { serverName, finalize } = context;
  let stdout = '';

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
      onData: () => {
        // 收集 stderr 但不使用，避免缓冲区满导致进程阻塞
      }
    },
    onError: (error) => {
      log('debug', `Process error for ${serverName}:`, error.message);
      finalize('failed');
    },
    onClose: (code) => {
      if (hasValidMcpResponse(stdout) || stdout.includes('MCP')) {
        finalize('connected', parseServerInfo(stdout));
      } else if (code !== 0) {
        finalize('failed');
      } else {
        finalize('pending');
      }
    },
    getStdout: () => stdout
  };
}

/**
 * 发送初始化请求到子进程
 * @param {import('child_process').ChildProcess} child - 子进程
 * @param {string} serverName - 服务器名称
 */
function sendInitializeRequest(child, serverName) {
  try {
    child.stdin.write(createInitializeRequest());
    child.stdin.end();
  } catch (e) {
    log('debug', `Failed to write to stdin for ${serverName}:`, e.message);
  }
}

// ============================================================================
// 核心验证逻辑
// ============================================================================

/**
 * 验证单个 MCP 服务器的连接状态
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息 { name, status, serverInfo, error? }
 */
export async function verifyMcpServerStatus(serverName, serverConfig) {
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
    const env = { ...process.env, ...(serverConfig.env || {}) };

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

    log('info', 'Verifying server:', serverName, 'command:', command);
    log('debug', 'Full command args:', args.length, 'arguments');

    // 完成处理函数
    const finalize = (status, serverInfo = null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      result.status = status;
      result.serverInfo = serverInfo;
      safeKillProcess(child, serverName);
      resolve(result);
    };

    // 设置超时
    const timeoutId = setTimeout(() => {
      log('debug', `Timeout for ${serverName} after ${MCP_VERIFY_TIMEOUT}ms`);
      finalize('pending');
    }, MCP_VERIFY_TIMEOUT);

    // 尝试启动进程
    try {
      child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
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

/**
 * 从 ~/.claude.json 读取 MCP 服务器配置
 * @returns {Promise<Array<{name: string, config: Object}>>} 启用的 MCP 服务器列表
 */
export async function loadMcpServersConfig() {
  try {
    const claudeJsonPath = join(homedir(), '.claude.json');

    if (!existsSync(claudeJsonPath)) {
      log('info', '~/.claude.json not found');
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
    log('error', 'Failed to load MCP servers config:', error.message);
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

    log('info', 'Found', enabledServers.length, 'enabled MCP servers, verifying...');

    // 并行验证所有服务器
    const results = await Promise.all(
      enabledServers.map(({ name, config }) => verifyMcpServerStatus(name, config))
    );

    return results;
  } catch (error) {
    log('error', 'Failed to get MCP servers status:', error.message);
    return [];
  }
}
