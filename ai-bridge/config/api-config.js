/**
 * API configuration module.
 * Loads and manages Claude API configuration.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getClaudeDir, getManagedSettingsPath } from '../utils/path-utils.js';

// Conditional debug logging: set CLAUDE_DEBUG=1 to enable verbose diagnostics
const DEBUG = process.env.CLAUDE_DEBUG === '1' || process.env.CLAUDE_DEBUG === 'true';
function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

/**
 * Network-related environment variable names that should be injected from
 * settings.json into process.env early at startup.
 *
 * IDEs launched via desktop launcher don't inherit shell proxy configuration,
 * so we need to explicitly read and set them from settings.json.
 *
 * For corporate SSL-inspection proxies, prefer NODE_EXTRA_CA_CERTS (path to
 * a PEM bundle) over NODE_TLS_REJECT_UNAUTHORIZED=0 — the former adds custom
 * CAs while keeping verification intact; the latter disables ALL verification.
 */
const NETWORK_ENV_VARS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
];

/**
 * Inject network-related environment variables from settings.json into process.env.
 *
 * This includes proxy settings AND TLS configuration. It must be called as early
 * as possible in every Node.js entry point — before any HTTPS connection is made
 * (including SDK preloading) — so that corporate proxies and custom CA setups work.
 *
 * Users behind corporate SSL-inspection proxies should prefer setting:
 *   { "env": { "NODE_EXTRA_CA_CERTS": "/path/to/ca-bundle.pem" } }
 *
 * As a last resort (disables ALL TLS verification — MITM risk):
 *   { "env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" } }
 *
 * @param {Object} [settings] - Parsed settings object. If omitted, loads from disk.
 */
export function injectNetworkEnvVars(settings) {
  const resolvedSettings = settings || loadClaudeSettings();
  for (const varName of NETWORK_ENV_VARS) {
    const value = resolvedSettings?.env?.[varName];
    if (value === undefined || value === null || process.env[varName]) {
      continue;
    }

    // Validate proxy URLs before injecting
    if (['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].includes(varName)) {
      try {
        new URL(String(value));
      } catch {
        debugLog(`[DEBUG] Skipping ${varName}: invalid URL "${value}"`);
        continue;
      }
    }

    process.env[varName] = String(value);
    debugLog(`[DEBUG] Set ${varName} from settings.json`);

    if (varName === 'NODE_TLS_REJECT_UNAUTHORIZED' && String(value) === '0') {
      console.warn('[SECURITY WARNING] TLS certificate verification is disabled via settings.json. All HTTPS connections are vulnerable to MITM attacks. Prefer NODE_EXTRA_CA_CERTS for corporate proxies.');
    }
  }
}

/**
 * Load managed settings from the platform-specific managed-settings.json.
 * These are typically configured by enterprise IT administrators.
 * @returns {Object|null} Parsed managed settings or null if not found/invalid
 */
export function loadManagedSettings() {
  try {
    const managedPath = getManagedSettingsPath();
    if (!existsSync(managedPath)) {
      return null;
    }
    const settings = JSON.parse(readFileSync(managedPath, 'utf8'));
    debugLog('[DEBUG] Loaded managed settings from:', managedPath);
    return settings;
  } catch (error) {
    debugLog('[DEBUG] Failed to load managed settings:', error.message);
    return null;
  }
}

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
 * Configure the API Key.
 * @returns {Object} Contains apiKey, baseUrl, authType and their sources
 */
export function setupApiKey() {
  debugLog('[DIAG-CONFIG] ========== setupApiKey() START ==========');

  const settings = loadClaudeSettings();
  debugLog('[DIAG-CONFIG] Settings loaded:', settings ? 'yes' : 'no');
  if (settings?.env) {
    debugLog('[DIAG-CONFIG] Settings env keys:', Object.keys(settings.env));
  }

  // Network env vars are already injected at module top-level in each entry
  // point (channel-manager.js, daemon.js) before any network activity occurs.

  let apiKey;
  let baseUrl;
  let authType = 'api_key';  // Default to api_key (x-api-key header)
  let apiKeySource = 'default';
  let baseUrlSource = 'default';

  // Configuration priority: only read from settings.json, ignore system environment variables.
  // This ensures a single source of truth and avoids interference from shell environment variables.
  debugLog('[DEBUG] Loading configuration from settings.json only (ignoring shell environment variables)...');

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

  // Marketplace-safe authentication policy:
  // Do NOT read Claude CLI login state from disk or Keychain.
  // Only explicit provider settings (or explicit apiKeyHelper) are supported.
  if (!apiKey) {
    debugLog('[DEBUG] No API Key found in settings.json, checking for apiKeyHelper...');

    // Check for apiKeyHelper in managed settings or user settings before giving up.
    // The SDK handles apiKeyHelper execution natively, so we just need to not throw.
    const managedSettings = loadManagedSettings();
    const hasApiKeyHelper = managedSettings?.apiKeyHelper || settings?.apiKeyHelper;

    if (hasApiKeyHelper) {
      debugLog('[INFO] Using apiKeyHelper authentication (SDK will handle execution)');
      authType = 'api_key_helper';
      apiKeySource = managedSettings?.apiKeyHelper
        ? 'managed-settings.json (apiKeyHelper)'
        : 'settings.json (apiKeyHelper)';

      // Clear all API Key environment variables so the SDK uses apiKeyHelper
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      if (baseUrl) {
        process.env.ANTHROPIC_BASE_URL = baseUrl;
      }

      debugLog('[DEBUG] Auth type:', authType);
      return { apiKey: null, baseUrl, authType, apiKeySource, baseUrlSource };
    }

    console.error('[ERROR] API Key not configured.');
    console.error('[ERROR] Please either:');
    console.error('[ERROR]   1. Configure ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in Provider Management');
    console.error('[ERROR]   2. Explicitly enable local ~/.claude/settings.json mode and set credentials there');
    console.error('[ERROR]   3. Configure apiKeyHelper in managed-settings.json or settings.json');
    throw new Error('API Key not configured');
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

  debugLog('[DEBUG] Auth type:', authType);

  debugLog('[DIAG-CONFIG] ========== setupApiKey() RESULT ==========');
  debugLog('[DIAG-CONFIG] authType:', authType);
  debugLog('[DIAG-CONFIG] apiKeySource:', apiKeySource);
  debugLog('[DIAG-CONFIG] baseUrl:', baseUrl || '(not set)');
  debugLog('[DIAG-CONFIG] baseUrlSource:', baseUrlSource);
  debugLog('[DIAG-CONFIG] apiKey configured:', apiKey ? 'YES' : 'NO');

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
