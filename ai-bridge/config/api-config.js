/**
 * API 配置模块
 * 负责加载和管理 Claude API 配置
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
 * 检查是否存在有效的 Claude CLI 会话认证
 * 通过检查 ~/.claude/.credentials.json 文件来判断用户是否已通过 'claude login' 登录
 *
 * @returns {boolean} 如果存在有效的CLI会话凭证返回true，否则返回false
 */
export function hasCliSessionAuth() {
  try {
    const credentialsPath = join(homedir(), '.claude', '.credentials.json');

    // 检查凭证文件是否存在
    if (!existsSync(credentialsPath)) {
      console.log('[DEBUG] No CLI session found: .credentials.json does not exist');
      return false;
    }

    // 读取并解析凭证文件
    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));

    // 验证是否存在有效的 OAuth access token
    const hasValidToken = credentials?.claudeAiOauth?.accessToken &&
                         credentials.claudeAiOauth.accessToken.length > 0;

    if (hasValidToken) {
      console.log('[DEBUG] Valid CLI session found with access token');
      return true;
    } else {
      console.log('[DEBUG] CLI credentials file exists but no valid access token found');
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
  const settings = loadClaudeSettings();

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
      apiKeySource = 'CLI session (~/.claude/.credentials.json)';

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
