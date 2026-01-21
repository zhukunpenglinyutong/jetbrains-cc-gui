/**
 * API 配置模块
 * 负责加载和管理 Claude API 配置
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execFileSync } from 'child_process';
import { debugLog, diagLog, errorLog } from '../utils/debug-logger.js';

/**
 * 读取 Claude Code 配置
 */
export function loadClaudeSettings() {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return settings;
  } catch (error) {
    return null;
  }
}

/**
 * Read credentials from macOS Keychain
 * @returns {Object|null} Credentials object or null if not found
 */
function readMacKeychainCredentials() {
  try {
    // Try different possible keychain service names
    const serviceNames = ['Claude Code-credentials', 'Claude Code'];

    for (const serviceName of serviceNames) {
      try {
        // 使用 execFileSync 替代 execSync，避免 shell 注入风险
        // 参数以数组形式传递，而非字符串拼接
        const result = execFileSync(
          'security',
          ['find-generic-password', '-s', serviceName, '-w'],
          { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );

        if (result && result.trim()) {
          const credentials = JSON.parse(result.trim());
          debugLog(`Successfully read credentials from macOS Keychain (service: ${serviceName})`);
          return credentials;
        }
      } catch (e) {
        // Continue to next service name
        continue;
      }
    }

    debugLog('No credentials found in macOS Keychain');
    return null;
  } catch (error) {
    debugLog('Failed to read from macOS Keychain:', error.message);
    return null;
  }
}

/**
 * Read credentials from file (Linux/Windows)
 * @returns {Object|null} Credentials object or null if not found
 */
function readFileCredentials() {
  try {
    const credentialsPath = join(homedir(), '.claude', '.credentials.json');

    if (!existsSync(credentialsPath)) {
      debugLog('No CLI session found: .credentials.json does not exist');
      return null;
    }

    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    debugLog('Successfully read credentials from file');
    return credentials;
  } catch (error) {
    debugLog('Failed to read credentials file:', error.message);
    return null;
  }
}

/**
 * 检查是否存在有效的 Claude CLI 会话认证
 * - macOS: 从系统钥匙串(Keychain)读取凭证
 * - Linux/Windows: 从 ~/.claude/.credentials.json 文件读取凭证
 *
 * @returns {boolean} 如果存在有效的CLI会话凭证返回true，否则返回false
 */
export function hasCliSessionAuth() {
  try {
    let credentials = null;
    const currentPlatform = platform();

    // macOS uses Keychain, other platforms use file
    if (currentPlatform === 'darwin') {
      debugLog('Detected macOS, attempting to read from Keychain...');
      credentials = readMacKeychainCredentials();

      // Fallback to file if keychain fails (in case user manually created the file)
      if (!credentials) {
        debugLog('Keychain read failed, trying file fallback...');
        credentials = readFileCredentials();
      }
    } else {
      debugLog(`Detected ${currentPlatform}, reading from credentials file...`);
      credentials = readFileCredentials();
    }

    // Validate OAuth access token
    const hasValidToken = credentials?.claudeAiOauth?.accessToken &&
                         credentials.claudeAiOauth.accessToken.length > 0;

    if (hasValidToken) {
      debugLog('Valid CLI session found with access token');
      return true;
    } else {
      debugLog('No valid access token found in credentials');
      return false;
    }
  } catch (error) {
    debugLog('Failed to check CLI session:', error.message);
    return false;
  }
}

/**
 * 配置 API Key
 * @returns {Object} 包含 apiKey, baseUrl, authType 及其来源
 */
export function setupApiKey() {
  diagLog('CONFIG', '========== setupApiKey() START ==========');

  const settings = loadClaudeSettings();
  diagLog('CONFIG', 'Settings loaded:', settings ? 'yes' : 'no');
  if (settings?.env) {
    diagLog('CONFIG', 'Settings env keys:', Object.keys(settings.env));
  }

  let apiKey;
  let baseUrl;
  let authType = 'api_key';  // 默认使用 api_key（x-api-key header）
  let apiKeySource = 'default';
  let baseUrlSource = 'default';

  // 🔥 配置优先级：只从 settings.json 读取，忽略系统环境变量
  // 这样确保配置来源唯一，避免 shell 环境变量干扰
  debugLog('Loading configuration from settings.json only (ignoring shell environment variables)...');

  // 优先使用 ANTHROPIC_AUTH_TOKEN（Bearer 认证），回退到 ANTHROPIC_API_KEY（x-api-key 认证）
  // 这样可以兼容 Claude Code CLI 的两种认证方式
  if (settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
    authType = 'auth_token';  // Bearer 认证
    apiKeySource = 'settings.json (ANTHROPIC_AUTH_TOKEN)';
  } else if (settings?.env?.ANTHROPIC_API_KEY) {
    apiKey = settings.env.ANTHROPIC_API_KEY;
    authType = 'api_key';  // x-api-key 认证
    apiKeySource = 'settings.json (ANTHROPIC_API_KEY)';
  } else if (settings?.env?.CLAUDE_CODE_USE_BEDROCK === '1' || settings?.env?.CLAUDE_CODE_USE_BEDROCK === 1 || settings?.env?.CLAUDE_CODE_USE_BEDROCK === 'true' || settings?.env?.CLAUDE_CODE_USE_BEDROCK === true) {
    apiKey = settings?.env?.CLAUDE_CODE_USE_BEDROCK;
    authType = 'aws_bedrock';  // aws_bedrock 认证
    apiKeySource = 'settings.json (AWS_BEDROCK)';
  }

  if (settings?.env?.ANTHROPIC_BASE_URL) {
    baseUrl = settings.env.ANTHROPIC_BASE_URL;
    baseUrlSource = 'settings.json';
  }

  // 如果没有配置 API Key，检查是否存在 CLI 会话认证
  if (!apiKey) {
    debugLog('No API Key found in settings.json, checking for CLI session...');

    if (hasCliSessionAuth()) {
      // 使用 CLI 会话认证
      debugLog('Using CLI session authentication (claude login)');
      authType = 'cli_session';
      // Set source based on platform
      const currentPlatform = platform();
      apiKeySource = currentPlatform === 'darwin'
        ? 'CLI session (macOS Keychain)'
        : 'CLI session (~/.claude/.credentials.json)';

      // 清除所有 API Key 相关的环境变量，让 SDK 自动检测 CLI 会话
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      // 设置 baseUrl (如果配置了)
      if (baseUrl) {
        process.env.ANTHROPIC_BASE_URL = baseUrl;
      }

      debugLog('Auth type:', authType);
      return { apiKey: null, baseUrl, authType, apiKeySource, baseUrlSource };
    } else {
      // 既没有 API Key 也没有 CLI 会话
      errorLog('API Key not configured and no CLI session found.');
      errorLog('Please either:');
      errorLog('  1. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json');
      errorLog('  2. Run "claude login" to authenticate via CLI');
      throw new Error('API Key not configured and no CLI session found');
    }
  }

  // 根据认证类型设置对应的环境变量
  if (authType === 'auth_token') {
    process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    // 清除 ANTHROPIC_API_KEY 避免混淆
    delete process.env.ANTHROPIC_API_KEY;
  } else if (authType === 'aws_bedrock') {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    process.env.ANTHROPIC_API_KEY = apiKey;
    // 清除 ANTHROPIC_AUTH_TOKEN 避免混淆
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }

  if (baseUrl) {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
  }

  debugLog('Auth type:', authType);

  diagLog('CONFIG', '========== setupApiKey() RESULT ==========');
  diagLog('CONFIG', 'authType:', authType);
  diagLog('CONFIG', 'apiKeySource:', apiKeySource);
  diagLog('CONFIG', 'baseUrl:', baseUrl || '(not set)');
  diagLog('CONFIG', 'baseUrlSource:', baseUrlSource);
  diagLog('CONFIG', 'apiKey:', apiKey ? '[CONFIGURED]' : '(null)');

  return { apiKey, baseUrl, authType, apiKeySource, baseUrlSource };
}

/**
 * 检测是否使用自定义 Base URL（非官方 Anthropic API）
 * @param {string} baseUrl - Base URL
 * @returns {boolean} 是否为自定义 URL
 */
export function isCustomBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  const officialUrls = [
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'api.anthropic.com'
  ];
  return !officialUrls.some(url => baseUrl.toLowerCase().includes('api.anthropic.com'));
}
