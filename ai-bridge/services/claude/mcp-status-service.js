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

/** HTTP/SSE 类型服务器验证超时时间（毫秒）- 网络请求通常较快，但需要考虑会话建立时间 */
const MCP_HTTP_VERIFY_TIMEOUT = parseInt(process.env.MCP_HTTP_VERIFY_TIMEOUT) || 6000;

/** STDIO 类型服务器验证超时时间（毫秒）- 需要启动进程，时间较长 */
const MCP_STDIO_VERIFY_TIMEOUT = parseInt(process.env.MCP_STDIO_VERIFY_TIMEOUT) || 30000; // 增加到30秒
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
 * 验证 HTTP/SSE 类型 MCP 服务器的连接状态
 * 实现基本的 MCP 初始化握手来验证服务器可用性
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息
 */
async function verifyHttpServerStatus(serverName, serverConfig) {
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

  log('info', '[MCP Verify] Verifying HTTP/SSE server:', serverName, 'URL:', url);

  // 创建带超时的控制器
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MCP_HTTP_VERIFY_TIMEOUT);

  try {
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

    // 构建请求头，包含授权信息（如果提供）
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(serverConfig.headers || {})
    };

    // 如果 URL 的查询字符串中包含 Authorization，提取并添加到请求头
    let fetchUrl = url;
    try {
      const urlObj = new URL(url);
      const authParam = urlObj.searchParams.get('Authorization');
      if (authParam) {
        headers['Authorization'] = authParam;
        urlObj.searchParams.delete('Authorization');
        fetchUrl = urlObj.toString();
      }
    } catch (e) {
      // URL 无效，使用原始 URL
    }

    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ': ' + response.statusText);
    }

    const responseText = await response.text();

    // 首先尝试解析为 SSE 格式
    const events = parseSSE(responseText);
    let data;
    if (events.length > 0 && events[0].data) {
      data = events[0].data;
    } else {
      // 回退到 JSON 解析
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        throw new Error('Failed to parse response: ' + parseError.message);
      }
    }

    if (data.error) {
      throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
    }

    // 检查是否有 serverInfo（某些服务器会返回）
    if (data.result && data.result.serverInfo) {
      result.status = 'connected';
      result.serverInfo = data.result.serverInfo;
      log('info', '[MCP Verify] HTTP/SSE server connected:', serverName);
    } else if (data.result) {
      // 服务器返回了有效的 result 但没有 serverInfo，也算连接成功
      result.status = 'connected';
      log('info', '[MCP Verify] HTTP/SSE server connected (no serverInfo):', serverName);
    } else {
      result.status = 'connected';
    }

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      result.status = 'pending';
      result.error = 'Connection timeout';
      log('debug', `[MCP Verify] HTTP/SSE server timeout: ${serverName}`);
    } else {
      result.status = 'failed';
      result.error = error.message;
      log('debug', `[MCP Verify] HTTP/SSE server failed: ${serverName}`, error.message);
    }
  }

  return result;
}

/**
 * 验证单个 MCP 服务器的连接状态
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 服务器状态信息 { name, status, serverInfo, error? }
 */
export async function verifyMcpServerStatus(serverName, serverConfig) {
  const serverType = serverConfig.type || 'stdio';

  // HTTP/SSE 类型服务器使用不同的验证逻辑
  if (serverType === 'http' || serverType === 'sse' || serverType === 'streamable-http') {
    return verifyHttpServerStatus(serverName, serverConfig);
  }

  // STDIO 类型服务器的原有逻辑
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

/**
 * 从 ~/.claude.json 读取 MCP 服务器配置
 * 支持两种模式：
 * 1. 全局配置 - 使用全局 mcpServers
 * 2. 项目配置 - 使用项目特定的 mcpServers
 * @param {string} cwd - 当前工作目录（用于检测项目）
 * @returns {Promise<Array<{name: string, config: Object}>>} 启用的 MCP 服务器列表
 */
export async function loadMcpServersConfig(cwd = null) {
  try {
    const claudeJsonPath = join(homedir(), '.claude.json');

    if (!existsSync(claudeJsonPath)) {
      log('info', '~/.claude.json not found');
      return [];
    }

    const content = await readFile(claudeJsonPath, 'utf8');
    const config = JSON.parse(content);

    // 规范化路径以匹配配置中的路径格式
    let normalizedCwd = cwd;
    if (cwd) {
      // 将路径转换为绝对路径并统一使用正斜杠
      normalizedCwd = cwd.replace(/\\/g, '/');
      // 移除尾部斜杠
      normalizedCwd = normalizedCwd.replace(/\/$/, '');
    }

    // 查找匹配的项目配置
    let projectConfig = null;
    if (normalizedCwd && config.projects) {
      // 尝试精确匹配项目路径
      if (config.projects[normalizedCwd]) {
        projectConfig = config.projects[normalizedCwd];
      } else {
        // 尝试将 cwd 转换为不同的格式进行匹配
        const cwdVariants = [
          normalizedCwd,
          normalizedCwd.replace(/\//g, '\\'),  // Windows 反斜杠格式
          '/' + normalizedCwd,                  // Unix 绝对路径格式
        ];

        for (const projectPath of Object.keys(config.projects)) {
          const normalizedProjectPath = projectPath.replace(/\\/g, '/');
          if (cwdVariants.includes(normalizedProjectPath)) {
            projectConfig = config.projects[projectPath];
            log('info', 'Found project config for:', projectPath);
            break;
          }
        }
      }
    }

    let mcpServers = {};
    let disabledServers = new Set();

    if (projectConfig) {
      // 模式 2: 使用项目特定的 MCP 配置
      log('info', '[MCP Config] Using project-specific MCP configuration');

      // 检查项目是否有自己的 mcpServers
      if (Object.keys(projectConfig.mcpServers || {}).length > 0) {
        mcpServers = projectConfig.mcpServers;
        disabledServers = new Set(projectConfig.disabledMcpServers || []);
      } else {
        // 项目没有自己的 mcpServers，使用全局配置
        // 但要应用项目级别的禁用列表
        log('info', '[MCP Config] Project has no MCP servers, using global config');
        mcpServers = config.mcpServers || {};

        // 合并全局和项目的禁用列表
        const globalDisabled = config.disabledMcpServers || [];
        const projectDisabled = projectConfig.disabledMcpServers || [];
        disabledServers = new Set([...globalDisabled, ...projectDisabled]);
      }
    } else {
      // 模式 1: 使用全局 MCP 配置
      log('info', '[MCP Config] Using global MCP configuration');
      mcpServers = config.mcpServers || {};
      disabledServers = new Set(config.disabledMcpServers || []);
    }

    const enabledServers = [];
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if (!disabledServers.has(serverName)) {
        enabledServers.push({ name: serverName, config: serverConfig });
      }
    }

    log('info', '[MCP Config] Loaded', enabledServers.length, 'enabled MCP servers');
    return enabledServers;
  } catch (error) {
    log('error', 'Failed to load MCP servers config:', error.message);
    return [];
  }
}

/**
 * 获取所有 MCP 服务器的连接状态
 * @param {string} cwd - 当前工作目录（用于检测项目配置）
 * @returns {Promise<Object[]>} MCP 服务器状态列表
 */
export async function getMcpServersStatus(cwd = null) {
  try {
    const enabledServers = await loadMcpServersConfig(cwd);

    log('info', 'Found', enabledServers.length, 'enabled MCP servers, verifying...');
    log('info', '[MCP Parallel] Starting parallel verification of', enabledServers.length, 'servers using Promise.all');
    log('info', '[MCP Parallel] Supports simultaneous processing of 10+ servers');

    // 并行验证所有服务器
    const results = await Promise.all(
      enabledServers.map(({ name, config }) => verifyMcpServerStatus(name, config))
    );

    log('info', '[MCP Parallel] Parallel verification completed for all', enabledServers.length, 'servers');
    return results;
  } catch (error) {
    log('error', 'Failed to get MCP servers status:', error.message);
    return [];
  }
}

// ============================================================================
// MCP 工具列表获取
// ============================================================================

/**
 * Parse SSE (Server-Sent Events) response
 * @param {string} text - SSE response text
 * @returns {Array<Object>} Array of parsed events
 */
function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = {};

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('data:')) {
      // Handle both "data: " and "data:" formats
      const data = trimmedLine.startsWith('data: ') ? trimmedLine.substring(6) : trimmedLine.substring(5);
      try {
        currentEvent.data = JSON.parse(data);
      } catch (e) {
        currentEvent.data = data;
      }
    } else if (trimmedLine.startsWith('event:')) {
      // Handle both "event: " and "event:" formats
      currentEvent.event = trimmedLine.startsWith('event: ') ? trimmedLine.substring(7) : trimmedLine.substring(6);
    } else if (trimmedLine.startsWith('id:')) {
      // Handle both "id: " and "id:" formats
      currentEvent.id = trimmedLine.startsWith('id: ') ? trimmedLine.substring(4) : trimmedLine.substring(3);
    } else if (trimmedLine === '') {
      // Empty line means end of event
      if (Object.keys(currentEvent).length > 0) {
        events.push(currentEvent);
        currentEvent = {};
      }
    }
  }

  // Don't forget the last event if there's no trailing newline
  if (Object.keys(currentEvent).length > 0) {
    events.push(currentEvent);
  }

  return events;
}

/**
 * 获取 HTTP/SSE 类型服务器的工具列表
 * 支持 MCP Streamable HTTP 的会话管理（Mcp-Session-Id）
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 工具列表响应
 */
async function getHttpServerTools(serverName, serverConfig) {
  const result = {
    name: serverName,
    tools: [],
    error: null,
    serverType: serverConfig.type || 'sse'
  };

  const url = serverConfig.url;
  if (!url) {
    result.error = 'No URL specified for HTTP/SSE server';
    return result;
  }

  log('info', '[MCP Tools] Starting tools fetch for HTTP/SSE server:', serverName);

  // Build headers with authorization if provided
  const baseHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(serverConfig.headers || {})
  };

  // If URL has Authorization in query string, extract it and add to headers
  let fetchUrl = url;
  try {
    const urlObj = new URL(url);
    const authParam = urlObj.searchParams.get('Authorization');
    if (authParam) {
      baseHeaders['Authorization'] = authParam;
      // Remove from URL to avoid duplicate
      urlObj.searchParams.delete('Authorization');
      fetchUrl = urlObj.toString();
    }
  } catch (e) {
    // Invalid URL, continue with original
  }

  let requestId = 0;
  let sessionId = null;

  /**
   * 发送 MCP 请求，支持会话管理和重试
   * @param {string} method - MCP 方法名
   * @param {Object} params - 请求参数
   * @param {number} retryCount - 当前重试次数
   * @returns {Promise<Object>} 响应数据
   */
  const sendRequest = async (method, params = {}, retryCount = 0) => {
    const id = ++requestId;
    const request = {
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params
    };

    // 构建请求头，包含会话 ID（如果存在）
    const headers = { ...baseHeaders };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
      log('debug', '[MCP Tools] Including session ID:', sessionId);
    }

    log('info', '[MCP Tools] ' + serverName + ' sending ' + method + ' request (id: ' + id + ')');

    // 指数退避超时：第一次 10s，第二次 15s，第三次 20s
    const timeoutMs = 10000 + (retryCount * 5000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(request),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // 如果是 404 或 405，可能是旧版 SSE 传输，需要特殊处理
        if (response.status === 404 || response.status === 405) {
          log('warn', '[MCP Tools] Server returned ' + response.status + ', may be using legacy SSE transport');
        }
        throw new Error('HTTP ' + response.status + ': ' + response.statusText);
      }

      // 提取会话 ID（从响应头）
      const responseSessionId = response.headers.get('Mcp-Session-Id');
      if (responseSessionId && !sessionId) {
        sessionId = responseSessionId;
        log('info', '[MCP Tools] Received session ID:', sessionId);
      }

      const responseText = await response.text();

      // Try to parse as SSE first
      const events = parseSSE(responseText);
      if (events.length > 0 && events[0].data) {
        const data = events[0].data;

        if (data.error) {
          // 如果是会话相关的错误，尝试重试
          if (data.error.code === -32600 || data.error.message?.includes('session')) {
            if (retryCount < 2) {
              log('warn', '[MCP Tools] Session error, retrying...');
              await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
              return sendRequest(method, params, retryCount + 1);
            }
          }
          throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
        }

        return data;
      }

      // Fall back to JSON parsing
      try {
        const data = JSON.parse(responseText);

        if (data.error) {
          // 如果是会话相关的错误，尝试重试
          if (data.error.code === -32600 || data.error.message?.includes('session')) {
            if (retryCount < 2) {
              log('warn', '[MCP Tools] Session error, retrying...');
              await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
              return sendRequest(method, params, retryCount + 1);
            }
          }
          throw new Error('Server error: ' + (data.error.message || JSON.stringify(data.error)));
        }

        return data;
      } catch (parseError) {
        throw new Error('Failed to parse response: ' + parseError.message);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout after ' + timeoutMs + 'ms');
      }
      // 网络错误重试
      if ((error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) && retryCount < 2) {
        log('warn', '[MCP Tools] Network error, retrying...', error.message);
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return sendRequest(method, params, retryCount + 1);
      }
      log('error', '[MCP Tools] ' + serverName + ' request failed:', error.message);
      throw error;
    }
  };

  try {
    // 发送初始化请求
    const initResponse = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codemoss-ide', version: '1.0.0' }
    });

    if (!initResponse.result) {
      throw new Error('Invalid initialize response: missing result');
    }

    log('info', '[MCP Tools] ' + serverName + ' initialized successfully');

    // 如果有会话 ID，现在已建立会话，后续请求将使用相同的会话
    if (sessionId) {
      log('info', '[MCP Tools] Using session:', sessionId);
    }

    // 发送 tools/list 请求（现在会包含会话 ID）
    const toolsResponse = await sendRequest('tools/list', {});

    if (toolsResponse.result && toolsResponse.result.tools) {
      const tools = toolsResponse.result.tools;
      log('info', '[MCP Tools] ' + serverName + ' received tools/list response: ' + tools.length + ' tools');
      result.tools = tools;
    } else {
      result.tools = [];
    }

  } catch (error) {
    log('error', '[MCP Tools] ' + serverName + ' failed:', error.message);
    result.error = error.message;
  }

  return result;
}

/**
 * 获取 STDIO 类型服务器的工具列表
 * 实现正确的 MCP STDIO 初始化流程：initialize → initialized → tools/list
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 工具列表响应
 */
async function getStdioServerTools(serverName, serverConfig) {
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
    const env = { ...process.env, ...(serverConfig.env || {}) };

    if (!command) {
      result.error = 'No command specified';
      resolve(result);
      return;
    }

    const validation = validateCommand(command);
    if (!validation.valid) {
      result.error = validation.reason;
      resolve(result);
      return;
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
        log('info', '[MCP Tools] ' + serverName + ' completed:', tools.length + ' tools');
      }
      resolve(result);
    };

    // 增加超时时间到 45 秒，某些 MCP 服务器首次启动较慢
    const timeoutId = setTimeout(() => {
      finalize(null, 'Timeout after 45s');
    }, 45000);

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
        if (!line.trim() || line.length > MAX_LINE_LENGTH) continue;

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
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'codemoss-ide', version: '1.0.0' }
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

/**
 * 发送 tools/list 请求到已连接的 MCP 服务器
 * @param {string} serverName - 服务器名称
 * @param {Object} serverConfig - 服务器配置
 * @returns {Promise<Object>} 工具列表响应
 */
export async function getMcpServerTools(serverName, serverConfig) {
  const serverType = serverConfig.type || 'stdio';

  // Support multiple HTTP-based server types
  if (serverType === 'http' || serverType === 'sse' || serverType === 'streamable-http') {
    return getHttpServerTools(serverName, serverConfig);
  }

  return getStdioServerTools(serverName, serverConfig);
}
