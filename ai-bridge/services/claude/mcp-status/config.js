/**
 * MCP server status detection configuration module
 * Contains all configuration constants and security whitelists
 */

// ============================================================================
// Timeout configuration
// ============================================================================

/** HTTP/SSE server verification timeout (ms) - network requests are usually fast, but session establishment time must be considered */
export const MCP_HTTP_VERIFY_TIMEOUT = parseInt(process.env.MCP_HTTP_VERIFY_TIMEOUT, 10) || 6000;

/** SSE server verification timeout (ms) - SSE requires event stream setup + endpoint discovery + initialize handshake */
export const MCP_SSE_VERIFY_TIMEOUT = parseInt(process.env.MCP_SSE_VERIFY_TIMEOUT, 10) || 10000;

/** SSE server tools list fetch timeout (ms) - requires completing handshake + initialize + tools/list */
export const MCP_SSE_TOOLS_TIMEOUT = parseInt(process.env.MCP_SSE_TOOLS_TIMEOUT, 10) || 30000;

/** STDIO server verification timeout (ms) - process startup is needed, but 15 seconds is sufficient for connectivity check */
export const MCP_STDIO_VERIFY_TIMEOUT = parseInt(process.env.MCP_STDIO_VERIFY_TIMEOUT, 10) || 15000;

/** Tools list fetch timeout (ms) */
export const MCP_TOOLS_TIMEOUT = parseInt(process.env.MCP_TOOLS_TIMEOUT, 10) || 45000;

// ============================================================================
// Debug configuration
// ============================================================================

/** Whether debug logging is enabled */
export const DEBUG = process.env.MCP_DEBUG === 'true' || process.env.DEBUG === 'true';

// ============================================================================
// Security whitelists
// ============================================================================

/**
 * Whitelist of allowed commands
 * Only common MCP server launch commands are permitted to prevent arbitrary command execution
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
 * Allowed executable file extensions (Windows)
 */
export const VALID_EXTENSIONS = new Set(['', '.exe', '.cmd', '.bat']);

/**
 * Whitelist of environment variables allowed to be passed to child processes
 * Only necessary variables are passed to prevent leaking sensitive information
 */
export const ALLOWED_ENV_VARS = new Set([
  // System essentials
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
  // Runtimes
  'DENO_DIR',
  'CARGO_HOME',
  'GOPATH',
  'GOROOT',
  // Windows-specific
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  // XDG specification
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);

/**
 * Create a safe environment variable object
 * Only includes whitelisted variables and user-configured variables
 * Also ensures PATH contains common tool installation directories (uvx, cargo, etc.)
 * @param {Object} serverEnv - Environment variables from server configuration
 * @returns {Object} Safe environment variable object
 */
export function createSafeEnv(serverEnv = {}) {
  const safeEnv = {};
  // Only copy whitelisted environment variables
  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key] !== undefined) {
      safeEnv[key] = process.env[key];
    }
  }
  // Enhance PATH: ensure common tool directories are included
  // When IDE is launched from the Dock, shell profile is not loaded, so PATH may be incomplete
  safeEnv.PATH = enhancePath(safeEnv.PATH || '');
  // Merge user-configured environment variables (user config takes precedence)
  return { ...safeEnv, ...serverEnv };
}

/**
 * Enhance PATH by appending common tool installation directories
 * Fixes the issue where IDE processes launched from GUI don't include user tool directories in PATH
 * @param {string} currentPath - Current PATH value
 * @returns {string} Enhanced PATH value
 */
function enhancePath(currentPath) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return currentPath;

  const separator = process.platform === 'win32' ? ';' : ':';
  const additionalPaths = [
    `${home}/.local/bin`,     // Python / uv / pip (uvx, uv, etc.)
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
// Other constants
// ============================================================================

/** Maximum output line length limit (prevents ReDoS attacks in server-info-parser regex matching) */
export const MAX_LINE_LENGTH = 10000;

/** Maximum line length limit for STDIO tools fetch (1MB, only JSON.parse so no ReDoS risk, but prevents memory exhaustion) */
export const STDIO_TOOLS_MAX_LINE_LENGTH = 1024 * 1024;
