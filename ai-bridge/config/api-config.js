/**
 * API 配置模块
 * 负责加载和管理 Claude API 配置
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { execSync } from 'child_process';
import { getClaudeDir } from '../utils/path-utils.js';

/**
 * 读取 Claude Code 配置
 */
export function loadClaudeSettings() {
  try {
    const settingsPath = join(getClaudeDir(), 'settings.json');
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
        const result = execSync(
          `security find-generic-password -s "${serviceName}" -w 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        );

        if (result && result.trim()) {
          const credentials = JSON.parse(result.trim());
          console.log(`[DEBUG] Successfully read credentials from macOS Keychain (service: ${serviceName})`);
          return credentials;
        }
      } catch (e) {
        // Continue to next service name
        continue;
      }
    }

    console.log('[DEBUG] No credentials found in macOS Keychain');
    return null;
  } catch (error) {
    console.log('[DEBUG] Failed to read from macOS Keychain:', error.message);
    return null;
  }
}

/**
 * Read credentials from file (Linux/Windows)
 * @returns {Object|null} Credentials object or null if not found
 */
function readFileCredentials() {
  try {
    const credentialsPath = join(getClaudeDir(), '.credentials.json');

    if (!existsSync(credentialsPath)) {
      console.log('[DEBUG] No CLI session found: .credentials.json does not exist');
      return null;
    }

    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    console.log('[DEBUG] Successfully read credentials from file');
    return credentials;
  } catch (error) {
    console.log('[DEBUG] Failed to read credentials file:', error.message);
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
      console.log('[DEBUG] Detected macOS, attempting to read from Keychain...');
      credentials = readMacKeychainCredentials();

      // Fallback to file if keychain fails (in case user manually created the file)
      if (!credentials) {
        console.log('[DEBUG] Keychain read failed, trying file fallback...');
        credentials = readFileCredentials();
      }
    } else {
      console.log(`[DEBUG] Detected ${currentPlatform}, reading from credentials file...`);
      credentials = readFileCredentials();
    }

    // Validate OAuth access token
    const hasValidToken = credentials?.claudeAiOauth?.accessToken &&
                         credentials.claudeAiOauth.accessToken.length > 0;

    if (hasValidToken) {
      console.log('[DEBUG] Valid CLI session found with access token');
      return true;
    } else {
      console.log('[DEBUG] No valid access token found in credentials');
      return false;
    }
  } catch (error) {
    console.log('[DEBUG] Failed to check CLI session:', error.message);
    return false;
  }
}

/**
 * 配置 API Key
 * @returns {Object} 包含 apiKey, baseUrl, authType 及其来源
 */
export function setupApiKey() {
  console.log('[DIAG-CONFIG] ========== setupApiKey() START ==========');

  const settings = loadClaudeSettings();
  console.log('[DIAG-CONFIG] Settings loaded:', settings ? 'yes' : 'no');
  if (settings?.env) {
    console.log('[DIAG-CONFIG] Settings env keys:', Object.keys(settings.env));
  }

  let apiKey;
  let baseUrl;
  let authType = 'api_key';  // 默认使用 api_key（x-api-key header）
  let apiKeySource = 'default';
  let baseUrlSource = 'default';

  // 🔥 配置优先级：只从 settings.json 读取，忽略系统环境变量
  // 这样确保配置来源唯一，避免 shell 环境变量干扰
  console.log('[DEBUG] Loading configuration from settings.json only (ignoring shell environment variables)...');

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
    console.log('[DEBUG] No API Key found in settings.json, checking for CLI session...');

    if (hasCliSessionAuth()) {
      // 使用 CLI 会话认证
      console.log('[INFO] Using CLI session authentication (claude login)');
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

      console.log('[DEBUG] Auth type:', authType);
      return { apiKey: null, baseUrl, authType, apiKeySource, baseUrlSource };
    } else {
      // 既没有 API Key 也没有 CLI 会话
      console.error('[ERROR] API Key not configured and no CLI session found.');
      console.error('[ERROR] Please either:');
      console.error('[ERROR]   1. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json');
      console.error('[ERROR]   2. Run "claude login" to authenticate via CLI');
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

  console.log('[DEBUG] Auth type:', authType);

  console.log('[DIAG-CONFIG] ========== setupApiKey() RESULT ==========');
  console.log('[DIAG-CONFIG] authType:', authType);
  console.log('[DIAG-CONFIG] apiKeySource:', apiKeySource);
  console.log('[DIAG-CONFIG] baseUrl:', baseUrl || '(not set)');
  console.log('[DIAG-CONFIG] baseUrlSource:', baseUrlSource);
  console.log('[DIAG-CONFIG] apiKey preview:', apiKey ? `${apiKey.substring(0, 10)}...` : '(null)');

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
