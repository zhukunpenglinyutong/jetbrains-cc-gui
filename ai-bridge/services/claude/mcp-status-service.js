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

/** 最大输出行长度限制（防止 ReDoS 攻击） */
const MAX_LINE_LENGTH = 10000;

// 启动时输出配置状态
if (DEBUG) {
  console.log('[McpStatus] Configuration loaded:', {
    MCP_VERIFY_TIMEOUT,
    DEBUG
  });
}

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
 * 验证命令是否有效
 * @param {string} command - 要验证的命令
 * @returns {{ valid: boolean, reason?: string }} 验证结果
 */
function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    return { valid: false, reason: 'Command is empty or invalid' };
  }

  // 命令存在即有效，不做白名单限制
  return { valid: true };
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

/**
 * 验证 HTTP/SSE 类型的 MCP 服务器
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息
 */
async function verifyHttpMcpServer(serverName, serverConfig) {
  const result = {
    name: serverName,
    status: 'pending',
    serverInfo: null
  };

  const url = serverConfig.url;
  if (!url) {
    result.status = 'failed';
    result.error = 'No URL specified for HTTP/SSE server';
    return result;
  }

  log('info', 'Verifying HTTP/SSE server:', serverName, 'url:', url, 'type:', serverConfig.type || 'auto');

  try {
    // 构建请求头
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(serverConfig.headers || {})
    };

    // 创建 MCP initialize 请求
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codemoss-ide', version: '1.0.0' }
      }
    };

    // 创建 AbortController 用于超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP_VERIFY_TIMEOUT);

    try {
      log('debug', `Sending HTTP request to ${serverName}:`, { url, headers: Object.keys(headers) });

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(initRequest),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      log('debug', `HTTP response from ${serverName}: status=${response.status}, contentType=${response.headers.get('content-type')}`);

      if (!response.ok) {
        result.status = 'failed';
        result.error = `HTTP ${response.status}: ${response.statusText}`;
        log('warn', `HTTP error for ${serverName}:`, result.error);
        return result;
      }

      const responseText = await response.text();
      log('debug', `HTTP response body for ${serverName}:`, responseText.substring(0, 500));

      // 尝试解析响应
      try {
        const data = JSON.parse(responseText);
        if (data.result && data.result.serverInfo) {
          result.status = 'connected';
          result.serverInfo = data.result.serverInfo;
          log('info', `HTTP MCP ${serverName} connected:`, result.serverInfo);
        } else if (data.error) {
          result.status = 'failed';
          result.error = data.error.message || JSON.stringify(data.error);
          log('warn', `HTTP MCP ${serverName} error response:`, result.error);
        } else if (data.jsonrpc || data.result !== undefined) {
          // 有效的 JSON-RPC 响应，即使没有 serverInfo
          result.status = 'connected';
          log('info', `HTTP MCP ${serverName} connected (no serverInfo)`);
        } else {
          result.status = 'failed';
          result.error = 'Invalid MCP response format: ' + responseText.substring(0, 100);
          log('warn', `HTTP MCP ${serverName} invalid format:`, responseText.substring(0, 200));
        }
      } catch (parseError) {
        // 如果响应包含 MCP 相关内容，认为是连接成功
        if (hasValidMcpResponse(responseText)) {
          result.status = 'connected';
          log('info', `HTTP MCP ${serverName} connected (non-JSON response)`);
        } else {
          result.status = 'failed';
          result.error = `Invalid JSON response: ${parseError.message}. Response: ${responseText.substring(0, 100)}`;
          log('warn', `HTTP MCP ${serverName} parse error:`, parseError.message);
        }
      }
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        result.status = 'pending';
        result.error = `Connection timeout after ${MCP_VERIFY_TIMEOUT}ms`;
        log('warn', `HTTP MCP ${serverName} timeout`);
      } else {
        result.status = 'failed';
        // 提供更详细的错误信息
        let errorDetail = fetchError.message;
        if (fetchError.cause) {
          errorDetail += ` (${fetchError.cause.code || fetchError.cause.message || fetchError.cause})`;
        }
        result.error = errorDetail;
        log('warn', `HTTP MCP ${serverName} fetch error:`, errorDetail);
      }
    }
  } catch (error) {
    result.status = 'failed';
    result.error = `Unexpected error: ${error.message}`;
    log('error', `HTTP MCP ${serverName} unexpected error:`, error);
  }

  return result;
}

/**
 * 判断服务器配置是否为 HTTP/SSE 类型
 * @param {Object} serverConfig - 服务器配置
 * @returns {boolean}
 */
function isHttpServer(serverConfig) {
  // 显式指定类型
  if (serverConfig.type === 'http' || serverConfig.type === 'sse') {
    log('debug', 'isHttpServer: true (explicit type)', serverConfig.type);
    return true;
  }
  // 有 url 但没有 command
  if (serverConfig.url && !serverConfig.command) {
    log('debug', 'isHttpServer: true (has url, no command)', serverConfig.url);
    return true;
  }
  log('debug', 'isHttpServer: false', { type: serverConfig.type, hasUrl: !!serverConfig.url, hasCommand: !!serverConfig.command });
  return false;
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
  log('debug', `Verifying server ${serverName}, config:`, JSON.stringify(serverConfig).substring(0, 300));

  // 检查是否为 HTTP/SSE 类型
  if (isHttpServer(serverConfig)) {
    return verifyHttpMcpServer(serverName, serverConfig);
  }

  // STDIO 类型的验证逻辑
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
    // Windows 上需要 shell: true 来执行 .cmd/.bat 文件（如 npx.cmd, npm.cmd）
    const isWindows = process.platform === 'win32';
    try {
      child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWindows
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
 * 验证项目路径是否安全（防止原型污染）
 * @param {string|null} projectPath - 项目路径
 * @returns {boolean} 是否为安全的项目路径
 */
function isValidProjectPath(projectPath) {
  return projectPath &&
    typeof projectPath === 'string' &&
    !['__proto__', 'constructor', 'prototype'].includes(projectPath);
}

/**
 * 从 ~/.claude.json 加载 MCP 服务器配置
 * @param {string} configPath - 配置文件路径
 * @param {string|null} projectPath - 项目路径
 * @returns {Promise<{mcpServers: Object, disabledServers: Set<string>}|null>}
 */
async function loadClaudeJsonConfig(configPath, projectPath) {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, 'utf8');
    const config = JSON.parse(content);

    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      return null;
    }

    const disabledServers = new Set();

    // 读取全局禁用列表
    if (config.disabledMcpServers && Array.isArray(config.disabledMcpServers)) {
      config.disabledMcpServers.forEach(name => disabledServers.add(name));
    }

    // 读取项目级别禁用列表
    if (isValidProjectPath(projectPath) &&
        config.projects &&
        Object.prototype.hasOwnProperty.call(config.projects, projectPath)) {
      const projectConfig = config.projects[projectPath];
      if (projectConfig.disabledMcpServers && Array.isArray(projectConfig.disabledMcpServers)) {
        projectConfig.disabledMcpServers.forEach(name => disabledServers.add(name));
        log('debug', `Merged project-level disabled servers from: ${projectPath}`);
      }
    }

    return { mcpServers: config.mcpServers, disabledServers };
  } catch (e) {
    log('warn', 'Failed to read ~/.claude.json:', e.message);
    return null;
  }
}

/**
 * 从 ~/.codemoss/config.json 加载 MCP 服务器配置（回退源）
 * @param {string} configPath - 配置文件路径
 * @returns {Promise<{mcpServers: Object, disabledServers: Set<string>}|null>}
 */
async function loadCodemossConfig(configPath) {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, 'utf8');
    const config = JSON.parse(content);

    if (!config.mcpServers || !Array.isArray(config.mcpServers)) {
      return null;
    }

    const mcpServers = {};
    const disabledServers = new Set();

    for (const server of config.mcpServers) {
      if (!server || !server.id) continue;

      mcpServers[server.id] = server.server || {
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        type: server.type
      };

      if (server.enabled === false) {
        disabledServers.add(server.id);
      }
    }

    return { mcpServers, disabledServers };
  } catch (e) {
    log('warn', 'Failed to read ~/.codemoss/config.json:', e.message);
    return null;
  }
}

/**
 * 过滤出启用的服务器列表
 * @param {Object} mcpServers - 服务器配置对象
 * @param {Set<string>} disabledServers - 禁用的服务器名称集合
 * @returns {Array<{name: string, config: Object}>}
 */
function filterEnabledServers(mcpServers, disabledServers) {
  return Object.entries(mcpServers)
    .filter(([name]) => !disabledServers.has(name))
    .map(([name, config]) => ({ name, config }));
}

/**
 * 从配置文件读取 MCP 服务器配置
 * 优先从 ~/.claude.json 读取，回退到 ~/.codemoss/config.json
 * @param {string|null} projectPath - 项目路径，用于读取项目级别的禁用列表
 * @returns {Promise<Array<{name: string, config: Object}>>} 启用的 MCP 服务器列表
 */
export async function loadMcpServersConfig(projectPath = null) {
  try {
    const homeDir = homedir();
    const claudeJsonPath = join(homeDir, '.claude.json');
    const codemossConfigPath = join(homeDir, '.codemoss', 'config.json');

    // 1. 尝试从 ~/.claude.json 加载
    let result = await loadClaudeJsonConfig(claudeJsonPath, projectPath);
    let configSource = result ? '~/.claude.json' : null;

    // 2. 回退到 ~/.codemoss/config.json
    if (!result) {
      result = await loadCodemossConfig(codemossConfigPath);
      configSource = result ? '~/.codemoss/config.json' : null;
    }

    // 3. 返回启用的服务器列表
    if (!result) {
      log('info', 'No MCP server config found');
      return [];
    }

    const enabledServers = filterEnabledServers(result.mcpServers, result.disabledServers);
    log('info', `Loaded ${enabledServers.length} enabled MCP servers from ${configSource} (disabled: ${result.disabledServers.size})`);

    return enabledServers;
  } catch (error) {
    log('error', 'Failed to load MCP servers config:', error.message);
    return [];
  }
}

/**
 * 获取所有 MCP 服务器的连接状态
 * @param {string|null} projectPath - 项目路径，用于读取项目级别的禁用列表
 * @returns {Promise<Object[]>} MCP 服务器状态列表
 */
export async function getMcpServersStatus(projectPath = null) {
  try {
    const enabledServers = await loadMcpServersConfig(projectPath);

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
