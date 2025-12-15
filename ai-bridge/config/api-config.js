/**
 * API 配置模块
 * 负责加载和管理 Claude API 配置
 */

import { readFileSync } from 'fs';
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

  // 🔥 统一配置优先级：系统环境变量 > settings.json
  // 这样所有配置都遵循相同的优先级规则，避免混淆
  if (settings?.env) {
    console.log('[DEBUG] Loading environment variables from settings.json...');
    const loadedVars = [];

    // 遍历所有环境变量并设置到 process.env
    for (const [key, value] of Object.entries(settings.env)) {
      // 只有当环境变量未被设置时才从配置文件读取（系统环境变量优先）
      if (process.env[key] === undefined && value !== undefined && value !== null) {
        process.env[key] = String(value);
        loadedVars.push(key);
      }
    }

    if (loadedVars.length > 0) {
      console.log(`[DEBUG] Loaded ${loadedVars.length} environment variables:`, loadedVars.join(', '));
    }
  }

  // 🔥 统一优先级：系统环境变量 > settings.json（与上面的通用逻辑一致）
  // 优先使用 ANTHROPIC_AUTH_TOKEN（Bearer 认证），回退到 ANTHROPIC_API_KEY（x-api-key 认证）
  // 这样可以兼容 Claude Code CLI 的两种认证方式
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
    authType = 'auth_token';  // Bearer 认证
    apiKeySource = 'environment (ANTHROPIC_AUTH_TOKEN)';
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    authType = 'api_key';  // x-api-key 认证
    apiKeySource = 'environment (ANTHROPIC_API_KEY)';
  } else if (settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
    authType = 'auth_token';  // Bearer 认证
    apiKeySource = 'settings.json (ANTHROPIC_AUTH_TOKEN)';
  } else if (settings?.env?.ANTHROPIC_API_KEY) {
    apiKey = settings.env.ANTHROPIC_API_KEY;
    authType = 'api_key';  // x-api-key 认证
    apiKeySource = 'settings.json (ANTHROPIC_API_KEY)';
  }

  if (process.env.ANTHROPIC_BASE_URL) {
    baseUrl = process.env.ANTHROPIC_BASE_URL;
    baseUrlSource = 'environment';
  } else if (settings?.env?.ANTHROPIC_BASE_URL) {
    baseUrl = settings.env.ANTHROPIC_BASE_URL;
    baseUrlSource = 'settings.json';
  }

  if (!apiKey) {
    console.error('[ERROR] API Key not configured. Please set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in environment or ~/.claude/settings.json');
    throw new Error('API Key not configured');
  }

  // 根据认证类型设置对应的环境变量
  if (authType === 'auth_token') {
    process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    // 清除 ANTHROPIC_API_KEY 避免混淆
    delete process.env.ANTHROPIC_API_KEY;
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
