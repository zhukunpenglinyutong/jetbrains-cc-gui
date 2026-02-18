/**
 * API configuration module.
 * Loads and manages Claude API configuration.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { execSync } from 'child_process';
import { getClaudeDir } from '../utils/path-utils.js';

/**
 * Read Claude Code configuration.
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
 * Check whether a valid Claude CLI session authentication exists.
 * - macOS: Reads credentials from the system Keychain
 * - Linux/Windows: Reads credentials from ~/.claude/.credentials.json
 *
 * @returns {boolean} True if valid CLI session credentials are found, false otherwise
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
 * Configure the API Key.
 * @returns {Object} Contains apiKey, baseUrl, authType and their sources
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
  let authType = 'api_key';  // Default to api_key (x-api-key header)
  let apiKeySource = 'default';
  let baseUrlSource = 'default';

  // Configuration priority: only read from settings.json, ignore system environment variables.
  // This ensures a single source of truth and avoids interference from shell environment variables.
  console.log('[DEBUG] Loading configuration from settings.json only (ignoring shell environment variables)...');

  // Prefer ANTHROPIC_AUTH_TOKEN (Bearer auth), fall back to ANTHROPIC_API_KEY (x-api-key auth).
  // This supports both authentication methods used by the Claude Code CLI.
  if (settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
    authType = 'auth_token';  // Bearer authentication
    apiKeySource = 'settings.json (ANTHROPIC_AUTH_TOKEN)';
  } else if (settings?.env?.ANTHROPIC_API_KEY) {
    apiKey = settings.env.ANTHROPIC_API_KEY;
    authType = 'api_key';  // x-api-key authentication
    apiKeySource = 'settings.json (ANTHROPIC_API_KEY)';
  } else if (settings?.env?.CLAUDE_CODE_USE_BEDROCK === '1' || settings?.env?.CLAUDE_CODE_USE_BEDROCK === 1 || settings?.env?.CLAUDE_CODE_USE_BEDROCK === 'true' || settings?.env?.CLAUDE_CODE_USE_BEDROCK === true) {
    apiKey = settings?.env?.CLAUDE_CODE_USE_BEDROCK;
    authType = 'aws_bedrock';  // AWS Bedrock authentication
    apiKeySource = 'settings.json (AWS_BEDROCK)';
  }

  if (settings?.env?.ANTHROPIC_BASE_URL) {
    baseUrl = settings.env.ANTHROPIC_BASE_URL;
    baseUrlSource = 'settings.json';
  }

  // If no API Key is configured, check for CLI session authentication
  if (!apiKey) {
    console.log('[DEBUG] No API Key found in settings.json, checking for CLI session...');

    if (hasCliSessionAuth()) {
      // Use CLI session authentication
      console.log('[INFO] Using CLI session authentication (claude login)');
      authType = 'cli_session';
      // Set source based on platform
      const currentPlatform = platform();
      apiKeySource = currentPlatform === 'darwin'
        ? 'CLI session (macOS Keychain)'
        : 'CLI session (~/.claude/.credentials.json)';

      // Clear all API Key environment variables so the SDK auto-detects the CLI session
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      // Set baseUrl if configured
      if (baseUrl) {
        process.env.ANTHROPIC_BASE_URL = baseUrl;
      }

      console.log('[DEBUG] Auth type:', authType);
      return { apiKey: null, baseUrl, authType, apiKeySource, baseUrlSource };
    } else {
      // Neither API Key nor CLI session found
      console.error('[ERROR] API Key not configured and no CLI session found.');
      console.error('[ERROR] Please either:');
      console.error('[ERROR]   1. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json');
      console.error('[ERROR]   2. Run "claude login" to authenticate via CLI');
      throw new Error('API Key not configured and no CLI session found');
    }
  }

  // Set the corresponding environment variables based on auth type
  if (authType === 'auth_token') {
    process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    // Clear ANTHROPIC_API_KEY to avoid confusion
    delete process.env.ANTHROPIC_API_KEY;
  } else if (authType === 'aws_bedrock') {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    process.env.ANTHROPIC_API_KEY = apiKey;
    // Clear ANTHROPIC_AUTH_TOKEN to avoid confusion
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
 * Detect whether a custom Base URL (non-official Anthropic API) is being used.
 * @param {string} baseUrl - Base URL
 * @returns {boolean} Whether the URL is custom
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
