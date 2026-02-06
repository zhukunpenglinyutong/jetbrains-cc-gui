/**
 * MCP 服务器状态检测配置模块
 * 包含所有配置常量和安全白名单
 */

// ============================================================================
// 超时配置
// ============================================================================

/** HTTP/SSE 类型服务器验证超时时间（毫秒）- 网络请求通常较快，但需要考虑会话建立时间 */
export const MCP_HTTP_VERIFY_TIMEOUT = parseInt(process.env.MCP_HTTP_VERIFY_TIMEOUT, 10) || 6000;

/** SSE 类型服务器验证超时时间（毫秒）- SSE 需要建立事件流 + endpoint 发现 + initialize 握手 */
export const MCP_SSE_VERIFY_TIMEOUT = parseInt(process.env.MCP_SSE_VERIFY_TIMEOUT, 10) || 10000;

/** SSE 类型服务器工具列表获取超时时间（毫秒）- 需要完成握手 + initialize + tools/list */
export const MCP_SSE_TOOLS_TIMEOUT = parseInt(process.env.MCP_SSE_TOOLS_TIMEOUT, 10) || 30000;

/** STDIO 类型服务器验证超时时间（毫秒）- 需要启动进程，但 15 秒足够验证连通性 */
export const MCP_STDIO_VERIFY_TIMEOUT = parseInt(process.env.MCP_STDIO_VERIFY_TIMEOUT, 10) || 15000;

/** 工具列表获取超时时间（毫秒） */
export const MCP_TOOLS_TIMEOUT = parseInt(process.env.MCP_TOOLS_TIMEOUT, 10) || 45000;

// ============================================================================
// 调试配置
// ============================================================================

/** 是否启用调试日志 */
export const DEBUG = process.env.MCP_DEBUG === 'true' || process.env.DEBUG === 'true';

// ============================================================================
// 安全白名单
// ============================================================================

/**
 * 允许执行的命令白名单
 * 只允许常见的 MCP 服务器启动命令，防止任意命令执行
 */
export const ALLOWED_COMMANDS = new Set([
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
  'java',
  'javaw',
  'kotlin',
]);

/**
 * 允许的可执行文件扩展名（Windows）
 */
export const VALID_EXTENSIONS = new Set(['', '.exe', '.cmd', '.bat']);

/**
 * 允许传递给子进程的环境变量白名单
 * 只传递必要的环境变量，避免泄露敏感信息
 */
export const ALLOWED_ENV_VARS = new Set([
  // 系统基础
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Node.js
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  // Python
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  // 运行时
  'DENO_DIR',
  'CARGO_HOME',
  'GOPATH',
  'GOROOT',
  // Windows 特定
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  // XDG 规范
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);

/**
 * 创建安全的环境变量对象
 * 只包含白名单中的变量和用户配置的变量
 * 同时确保 PATH 包含常见工具安装目录（uvx, cargo 等）
 * @param {Object} serverEnv - 服务器配置中的环境变量
 * @returns {Object} 安全的环境变量对象
 */
export function createSafeEnv(serverEnv = {}) {
  const safeEnv = {};
  // 只复制白名单中的环境变量
  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key] !== undefined) {
      safeEnv[key] = process.env[key];
    }
  }
  // 增强 PATH：确保常见工具目录被包含
  // IDE 从 Dock 启动时不会加载 shell 配置文件，PATH 可能不完整
  safeEnv.PATH = enhancePath(safeEnv.PATH || '');
  // 合并用户配置的环境变量（用户配置优先）
  return { ...safeEnv, ...serverEnv };
}

/**
 * 增强 PATH，追加常见的工具安装目录
 * 解决从 GUI 启动的 IDE 进程 PATH 不包含用户工具目录的问题
 * @param {string} currentPath - 当前 PATH
 * @returns {string} 增强后的 PATH
 */
function enhancePath(currentPath) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return currentPath;

  const separator = process.platform === 'win32' ? ';' : ':';
  const additionalPaths = [
    `${home}/.local/bin`,     // Python / uv / pip（uvx, uv 等）
    `${home}/.cargo/bin`,     // Rust / cargo
  ];

  const pathParts = currentPath.split(separator);
  const pathSet = new Set(pathParts);

  for (const p of additionalPaths) {
    if (!pathSet.has(p)) {
      pathParts.push(p);
    }
  }

  return pathParts.join(separator);
}

// ============================================================================
// 其他常量
// ============================================================================

/** 最大输出行长度限制（防止 ReDoS 攻击，用于 server-info-parser 的正则匹配） */
export const MAX_LINE_LENGTH = 10000;

/** STDIO 工具获取的最大行长度限制（1MB，仅做 JSON.parse 无 ReDoS 风险，但需防止内存耗尽） */
export const STDIO_TOOLS_MAX_LINE_LENGTH = 1024 * 1024;
