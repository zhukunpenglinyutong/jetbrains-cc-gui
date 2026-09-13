/**
 * Grok utilities — binary resolution, env handling, error formatting.
 * ACP primary (`grok agent stdio`); headless remains secondary fallback option.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function resolveGrokBinary() {
  const explicit = process.env.GROK_CLI_PATH;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  // Common install locations
  const candidates = [
    join(homedir(), '.grok', 'bin', 'grok'),
    join(homedir(), '.local', 'bin', 'grok'),
    '/usr/local/bin/grok',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Fall back to PATH
  return explicit || 'grok';
}

/**
 * Normalize model identifier for Grok.
 * Sentinel or fallback values ("grok", "", "auto", "default", "(default)",
 * "__config_default__", "config-default", ...) map to "grok-4.6".
 * Legacy "grok-4.5" is also upgraded to "grok-4.6".
 * Keep the sentinel set aligned with cli-ask.js isDefaultModelToken so a
 * placeholder never leaks into session/new as a literal model id.
 */
export function normalizeGrokModelId(modelId) {
  const lower = String(modelId || '').trim().toLowerCase();
  if (
    !lower
    || lower === 'grok'
    || lower === 'auto'
    || lower === 'default'
    || lower === '(default)'
    || lower === '__config_default__'
    || lower === 'config-default'
    || lower === 'config_default'
    || lower === 'grok-4.5'
  ) {
    return 'grok-4.6';
  }
  return String(modelId).trim();
}

/** GROK_HOME or default ~/.grok */
export function resolveGrokHomeDir() {
  const env = process.env.GROK_HOME;
  if (env && String(env).trim()) return String(env).trim();
  return join(homedir(), '.grok');
}

/**
 * True when ~/.grok/auth.json holds a usable OAuth/session credential.
 * Empty `{}` / missing file → false (plugin should fall back to config api_key).
 */
export function hasGrokOAuthToken(grokHome = resolveGrokHomeDir()) {
  try {
    const path = join(grokHome, 'auth.json');
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    return credentialObjectHasToken(data);
  } catch {
    return false;
  }
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function credentialObjectHasToken(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (nonEmptyString(data.access_token) || nonEmptyString(data.token) || nonEmptyString(data.refresh_token)) {
    return true;
  }
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (nonEmptyString(v.access_token) || nonEmptyString(v.token) || nonEmptyString(v.refresh_token)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Minimal TOML parse for Grok CLI config credentials.
 * Supports:
 *   [models] default = "profile"
 *   [model.profile] / [model."profile"] api_key / base_url
 * If no default, uses the first [model.*] table that has api_key.
 *
 * @param {string} text
 * @returns {{ apiKey: string, baseUrl: string, profile: string }}
 */
export function parseGrokConfigTomlCredentials(text) {
  const empty = { apiKey: '', baseUrl: '', profile: '' };
  const src = String(text || '');
  if (!src.trim()) return empty;

  const defaultMatch =
    src.match(/^\s*default\s*=\s*"([^"]+)"\s*$/m) ||
    src.match(/^\s*default\s*=\s*'([^']+)'\s*$/m);
  const defaultProfile = defaultMatch ? defaultMatch[1].trim() : '';

  /** @type {Map<string, { apiKey: string, baseUrl: string }>} */
  const profiles = new Map();
  const sectionRe = /^\s*\[([^\]]+)\]\s*$/gm;
  const sections = [];
  let m;
  while ((m = sectionRe.exec(src)) !== null) {
    sections.push({ name: m[1].trim(), start: m.index + m[0].length, headerEnd: m.index });
  }
  for (let i = 0; i < sections.length; i++) {
    const end = i + 1 < sections.length ? sections[i + 1].headerEnd : src.length;
    const body = src.slice(sections[i].start, end);
    const name = sections[i].name;
    // model.NAME or model."NAME" / model.'NAME'
    const modelMatch =
      name.match(/^model\."([^"]+)"$/) ||
      name.match(/^model\.'([^']+)'$/) ||
      name.match(/^model\.([^.]+)$/);
    if (!modelMatch) continue;
    const profile = modelMatch[1].trim();
    if (!profile) continue;
    const apiKey =
      extractTomlString(body, 'api_key') ||
      extractTomlString(body, 'apiKey') ||
      '';
    const baseUrl =
      extractTomlString(body, 'base_url') ||
      extractTomlString(body, 'baseUrl') ||
      '';
    profiles.set(profile, { apiKey, baseUrl });
  }

  if (defaultProfile && profiles.has(defaultProfile)) {
    const p = profiles.get(defaultProfile);
    return { apiKey: p.apiKey || '', baseUrl: p.baseUrl || '', profile: defaultProfile };
  }
  for (const [profile, p] of profiles) {
    if (p.apiKey) {
      return { apiKey: p.apiKey, baseUrl: p.baseUrl || '', profile };
    }
  }
  if (defaultProfile && profiles.size === 0) {
    return empty;
  }
  // No api_key anywhere — still return default profile base_url if present
  if (defaultProfile && profiles.has(defaultProfile)) {
    const p = profiles.get(defaultProfile);
    return { apiKey: '', baseUrl: p.baseUrl || '', profile: defaultProfile };
  }
  return empty;
}

function extractTomlString(sectionBody, key) {
  const reDq = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm');
  const reSq = new RegExp(`^\\s*${key}\\s*=\\s*'([^']*)'\\s*$`, 'm');
  const match = sectionBody.match(reDq) || sectionBody.match(reSq);
  return match ? match[1].trim() : '';
}

/**
 * Read api_key + base_url from ~/.grok/config.toml (CLI-native credentials).
 */
export function readGrokConfigTomlCredentials(grokHome = resolveGrokHomeDir()) {
  try {
    const path = join(grokHome, 'config.toml');
    if (!existsSync(path)) {
      return { apiKey: '', baseUrl: '', profile: '' };
    }
    return parseGrokConfigTomlCredentials(readFileSync(path, 'utf8'));
  } catch {
    return { apiKey: '', baseUrl: '', profile: '' };
  }
}

/**
 * Resolve effective auth for ACP / daemon.
 *
 * Compatibility rule (default oauth):
 * - If ~/.grok/auth.json has a token → stay oauth and strip API keys
 *   (avoids SuperGrok 403 "no credits" from host team keys).
 * - If OAuth token is missing → fall back to plugin apiKey or
 *   ~/.grok/config.toml [model.*].api_key (+ base_url).
 * - Never fall back to ambient process.env XAI_API_KEY on the oauth path
 *   (same SuperGrok pitfall).
 *
 * @returns {{
 *   authMethod: string,
 *   apiKey: string,
 *   baseUrl: string,
 *   reason: string,
 *   fellBackFromOauth: boolean,
 * }}
 */
export function resolveEffectiveGrokAuth({
  preferredAuth = '',
  apiKey = '',
  baseUrl = '',
  hasOAuthToken = hasGrokOAuthToken,
  readConfigCredentials = readGrokConfigTomlCredentials,
} = {}) {
  const preferred = normalizeAuthMethod(preferredAuth) || 'oauth';
  const explicitKey = String(apiKey || '').trim();
  const explicitBase = String(baseUrl || '').trim();

  const loadConfig = () => {
    try {
      const c = readConfigCredentials() || {};
      return {
        apiKey: String(c.apiKey || '').trim(),
        baseUrl: String(c.baseUrl || '').trim(),
        profile: String(c.profile || '').trim(),
      };
    } catch {
      return { apiKey: '', baseUrl: '', profile: '' };
    }
  };

  if (preferred === 'api_key') {
    const cfg = explicitKey && explicitBase ? { apiKey: '', baseUrl: '' } : loadConfig();
    return {
      authMethod: 'api_key',
      apiKey: explicitKey || cfg.apiKey || '',
      baseUrl: explicitBase || cfg.baseUrl || '',
      reason: explicitKey ? 'api_key-explicit' : (cfg.apiKey ? 'api_key-from-config' : 'api_key-empty'),
      fellBackFromOauth: false,
    };
  }

  if (preferred === 'auto') {
    if (typeof hasOAuthToken === 'function' ? hasOAuthToken() : !!hasOAuthToken) {
      return {
        authMethod: 'oauth',
        apiKey: '',
        baseUrl: explicitBase,
        reason: 'auto-oauth-token',
        fellBackFromOauth: false,
      };
    }
    const cfg = loadConfig();
    const key = explicitKey || cfg.apiKey || '';
    if (key) {
      return {
        authMethod: 'api_key',
        apiKey: key,
        baseUrl: explicitBase || cfg.baseUrl || '',
        reason: 'auto-api-key',
        fellBackFromOauth: false,
      };
    }
    return {
      authMethod: 'oauth',
      apiKey: '',
      baseUrl: explicitBase,
      reason: 'auto-oauth-login',
      fellBackFromOauth: false,
    };
  }

  // preferred === oauth (plugin default)
  const oauthPresent = typeof hasOAuthToken === 'function' ? hasOAuthToken() : !!hasOAuthToken;
  if (oauthPresent) {
    return {
      authMethod: 'oauth',
      apiKey: '',
      baseUrl: explicitBase,
      reason: 'oauth-token',
      fellBackFromOauth: false,
    };
  }

  const cfg = loadConfig();
  // Prefer explicit plugin key, then config.toml — never ambient env on this path.
  const key = explicitKey || cfg.apiKey || '';
  if (key) {
    return {
      authMethod: 'api_key',
      apiKey: key,
      baseUrl: explicitBase || cfg.baseUrl || '',
      reason: explicitKey
        ? 'oauth-empty-fallback-plugin-api-key'
        : 'oauth-empty-fallback-config-api-key',
      fellBackFromOauth: true,
    };
  }

  return {
    authMethod: 'oauth',
    apiKey: '',
    baseUrl: explicitBase,
    reason: 'oauth-login-required',
    fellBackFromOauth: false,
  };
}

export function buildGrokEnv(baseEnv = process.env, apiKey, baseUrl, authMethod = '', resolveOptions = null) {
  const env = { ...baseEnv };

  // Clean up potentially conflicting vars
  delete env.CLAUDE_API_KEY;
  delete env.CODEX_API_KEY;

  let method = normalizeAuthMethod(authMethod || env.GROK_AUTH_METHOD || '');
  let effectiveKey = apiKey;
  let effectiveBase = baseUrl;

  // Apply OAuth-empty → config.toml / plugin api_key fallback before env assembly.
  // resolveOptions === false disables (tests / callers that already resolved).
  if (resolveOptions !== false) {
    const resolved = resolveEffectiveGrokAuth({
      preferredAuth: method || authMethod || env.GROK_AUTH_METHOD || '',
      apiKey: effectiveKey,
      baseUrl: effectiveBase,
      ...(resolveOptions && typeof resolveOptions === 'object' ? resolveOptions : {}),
    });
    method = resolved.authMethod;
    effectiveKey = resolved.apiKey;
    effectiveBase = resolved.baseUrl;
    if (resolved.fellBackFromOauth) {
      console.error(
        '[GROK] OAuth token missing; falling back to api_key (' + resolved.reason + ')'
      );
    }
  }

  if (method === 'oauth') {
    // Do not let host/process API keys force xai.api_key over cached OAuth token.
    delete env.XAI_API_KEY;
    delete env.GROK_API_KEY;
  } else if (effectiveKey) {
    env.XAI_API_KEY = effectiveKey;
    env.GROK_API_KEY = effectiveKey;
  } else if (method === 'api_key') {
    // keep existing env keys if present
  }

  if (method) {
    env.GROK_AUTH_METHOD = method;
  }

  applyGrokBaseUrlEnv(env, method, effectiveBase);

  // Force non-interactive / no update noise on ACP stdio
  env.GROK_NO_AUTO_UPDATE = '1';
  env.CI = env.CI || '1';

  // Sanitize IDE context variables.
  // These can leak into Grok CLI and its run_terminal_command children (e.g. mvn),
  // causing build tools to detect "running under IntelliJ" and attempt Apple Events
  // to the IDE → macOS shows ""IntelliJ IDEA" would like to access data from other apps".
  // Claude path does not leak them the same way.
  delete env.IDEA_PROJECT_PATH;
  delete env.PROJECT_PATH;
  for (const k of Object.keys(env)) {
    if (k.startsWith('IDEA_') || k.startsWith('JETBRAINS_')) {
      delete env[k];
    }
  }

  return env;
}

/**
 * Apply gateway base URL overrides per auth method.
 * Empty baseUrl leaves CLI defaults (direct xAI / cli-chat-proxy.grok.com).
 *
 * Official Grok CLI env (see CLI README):
 * - GROK_CLI_CHAT_PROXY_BASE_URL — SuperGrok / cli-chat-proxy chat path
 * - GROK_MODELS_BASE_URL — inference + GET {base}/models (api_key / custom endpoint)
 * - GROK_MODELS_LIST_URL — optional override for model list URL
 *
 * Plugin-only aliases (not documented by CLI; kept for older paths):
 * - XAI_API_BASE_URL, GROK_BASE_URL
 *
 * Live fix (gateway + hosts block): without GROK_MODELS_BASE_URL the CLI never
 * hits local-agent (:18790) in api_key mode — hang + silent agent log.
 * Always set GROK_MODELS_* alongside chat-proxy when a base is configured.
 */
export function applyGrokBaseUrlEnv(env, authMethod, baseUrl) {
  const url = String(baseUrl || '').trim();
  if (!url) return env;
  const method = normalizeAuthMethod(authMethod) || 'oauth';
  const modelsList = url.replace(/\/+$/, '') + '/models';

  // Always: inference/models path used by api_key and many agent turns.
  env.GROK_MODELS_BASE_URL = url;
  env.GROK_MODELS_LIST_URL = modelsList;
  env.GROK_BASE_URL = url;

  if (method === 'api_key') {
    env.XAI_API_BASE_URL = url;
    // Agent/chat still uses cli-chat-proxy base; without it, default
    // cli-chat-proxy.grok.com is hosts-blocked → hang.
    env.GROK_CLI_CHAT_PROXY_BASE_URL = url;
  } else if (method === 'oauth') {
    env.GROK_CLI_CHAT_PROXY_BASE_URL = url;
    delete env.XAI_API_BASE_URL;
  } else {
    env.XAI_API_BASE_URL = url;
    env.GROK_CLI_CHAT_PROXY_BASE_URL = url;
  }
  return env;
}

/** True when URL looks like gateway root /v1 without /xai or /grok namespace. */
export function isBareGatewayV1Base(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return false;
  // …/v1 but not …/xai/v1 or …/grok/v1
  if (!/\/v1$/i.test(u)) return false;
  if (/\/(xai|grok)\/v1$/i.test(u)) return false;
  return true;
}

export function normalizeAuthMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (m === 'api_key' || m === 'xai.api_key' || m === 'apikey') return 'api_key';
  if (m === 'auto') return 'auto';
  if (m === 'oauth' || m === 'cached_token' || m === 'cli_login' || m === 'grok.com') return 'oauth';
  return m || '';
}

/**
 * Select ACP authenticate methodId given agent authMethods + plugin preference.
 * Priority when preferred=oauth: cached_token > grok.com > (never api_key unless only option)
 * preferred=api_key: xai.api_key if key present
 * preferred=auto: cached_token/oauth first, then api_key
 */
export function selectGrokAuthMethodId({
  authMethods = new Set(),
  defaultAuth = null,
  preferred = 'oauth',
  hasApiKey = false,
} = {}) {
  const methods = authMethods instanceof Set
    ? authMethods
    : new Set((authMethods || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean));

  const pref = normalizeAuthMethod(preferred) || 'oauth';

  const pickOAuth = () => {
    if (methods.has('cached_token')) return 'cached_token';
    if (methods.has('grok.com')) return 'grok.com';
    return null;
  };
  const pickApiKey = () => (hasApiKey && methods.has('xai.api_key') ? 'xai.api_key' : null);

  if (pref === 'oauth') {
    return pickOAuth() || (methods.has('xai.api_key') && hasApiKey ? 'xai.api_key' : null);
  }
  if (pref === 'api_key') {
    return pickApiKey() || pickOAuth();
  }
  // auto: honor agent default only if not forcing api without key; prefer oauth when present
  const oauth = pickOAuth();
  if (oauth) return oauth;
  if (defaultAuth && methods.has(defaultAuth)) {
    if (defaultAuth !== 'xai.api_key' || hasApiKey) return defaultAuth;
  }
  return pickApiKey();
}

export function buildErrorPayload(error) {
  return {
    success: false,
    error: error?.message || String(error),
    stack: error?.stack,
  };
}

/**
 * First finite number > 0 among keys (or 0).
 * Prefer listing snake_case before camelCase so OpenAI-shaped payloads win when both exist.
 * @param {Record<string, unknown>} obj
 * @param {...string} keys
 */
function firstPositiveNumber(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    const n = Number(obj[key]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

/**
 * Canonical OpenAI-style snake_case usage for [USAGE] tags and Java consumers.
 * ACP often emits camelCase (totalTokens/inputTokens); normalize so snake_case is primary
 * and dual-read extractors remain a fallback for raw payloads.
 *
 * @param {unknown} usage
 * @returns {Record<string, number>|null}
 */
export function normalizeUsageToSnakeCase(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const src = /** @type {Record<string, unknown>} */ (usage);
  // Nested { usage: {...} } from some ACP envelopes
  if (
    src.usage &&
    typeof src.usage === 'object' &&
    !Array.isArray(src.usage) &&
    !firstPositiveNumber(src, 'total_tokens', 'totalTokens', 'input_tokens', 'inputTokens')
  ) {
    const nested = normalizeUsageToSnakeCase(src.usage);
    if (nested) return nested;
  }

  const total = firstPositiveNumber(src, 'total_tokens', 'totalTokens');
  const input = firstPositiveNumber(src, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  const output = firstPositiveNumber(src, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  // ACP turn_completed uses reasoningTokens; chat API uses completion_tokens_details.reasoning_tokens
  const thought = firstPositiveNumber(
    src,
    'thought_tokens',
    'thoughtTokens',
    'reasoning_tokens',
    'reasoningTokens',
  );
  const cachedWrite = firstPositiveNumber(src, 'cached_write_tokens', 'cachedWriteTokens');
  const cachedRead = firstPositiveNumber(
    src,
    'cached_read_tokens',
    'cachedReadTokens',
    'cached_tokens',
    'cachedTokens',
  );

  if (total <= 0 && input <= 0 && output <= 0 && thought <= 0 && cachedWrite <= 0 && cachedRead <= 0) {
    return null;
  }

  /** @type {Record<string, number>} */
  const out = {};
  if (input > 0) out.input_tokens = input;
  if (output > 0) out.output_tokens = output;
  if (thought > 0) out.thought_tokens = thought;
  if (cachedWrite > 0) out.cached_write_tokens = cachedWrite;
  if (cachedRead > 0) out.cached_read_tokens = cachedRead;
  out.total_tokens =
    total > 0 ? total : input + output + thought + cachedWrite + cachedRead;
  return out;
}

/**
 * Pull a usage-like object from ACP notification/result envelopes.
 * Real Grok CLI (0.2.x) does NOT emit sessionUpdate=usage_update. Instead:
 * - session/prompt result._meta.usage / result._meta.totalTokens
 * - method _x.ai/session_notification, update.sessionUpdate=turn_completed + update.usage
 * - optional nested result.usage
 *
 * @param {unknown} methodOrPayload  notification method string, or a prompt result object
 * @param {unknown} [params]         notification params when methodOrPayload is a method name
 * @returns {Record<string, unknown>|null}
 */
export function extractUsageFromAcpEnvelope(methodOrPayload, params) {
  // Notification form: (method, params)
  if (typeof methodOrPayload === 'string') {
    const method = methodOrPayload;
    const p = params && typeof params === 'object' ? params : null;
    if (!p) return null;

    // Standard ACP session/update usage_update (rarely emitted by current CLI)
    if (method === 'session/update') {
      const update = p.update || p;
      const kind = update?.sessionUpdate || update?.type || '';
      if (kind === 'usage_update' || kind === 'usage') {
        return update.usage || update;
      }
      if (kind === 'turn_completed' && update?.usage) {
        return update.usage;
      }
      if (update?.usage) return update.usage;
      return null;
    }

    // Vendor extension: _x.ai/session_notification { update: { sessionUpdate, usage } }
    if (
      method === '_x.ai/session_notification' ||
      method === 'x.ai/session_notification' ||
      method.endsWith('/session_notification')
    ) {
      const update = p.update || p;
      if (update?.usage) return update.usage;
      if (update?.sessionUpdate === 'turn_completed' && update) {
        // usage may be sibling fields on update
        if (update.totalTokens || update.inputTokens) return update;
      }
      return null;
    }

    return null;
  }

  // Prompt-result form: object
  const result = methodOrPayload;
  if (!result || typeof result !== 'object') return null;
  if (result.usage && typeof result.usage === 'object') return result.usage;
  const meta = result._meta || result.meta;
  if (meta && typeof meta === 'object') {
    if (meta.usage && typeof meta.usage === 'object') return meta.usage;
    // Flatten meta totals when usage object missing
    if (meta.totalTokens || meta.inputTokens || meta.total_tokens) return meta;
  }
  // Top-level totals on some envelopes
  if (result.totalTokens || result.inputTokens || result.total_tokens) return result;
  return null;
}

/**
 * Extract aggregate used-token count from a Grok/ACP usage object.
 * Mirrors Java {@code GrokContextUsageBuilder.extractUsedTokens}.
 * Primary: snake_case. Fallback: Grok ACP camelCase (totalTokens, inputTokens, …).
 */
export function extractUsedTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const normalized = normalizeUsageToSnakeCase(usage);
  if (normalized) {
    const total = Number(normalized.total_tokens);
    if (Number.isFinite(total) && total > 0) return Math.floor(total);
    let used = 0;
    for (const key of ['input_tokens', 'output_tokens', 'thought_tokens', 'cached_write_tokens', 'cached_read_tokens']) {
      const n = Number(normalized[key]);
      if (Number.isFinite(n) && n > 0) used += n;
    }
    if (used > 0) return Math.max(0, Math.floor(used));
  }
  // Last-resort dual-read without normalize (empty / exotic shapes)
  const total = firstPositiveNumber(usage, 'total_tokens', 'totalTokens');
  if (total > 0) return total;
  let used = 0;
  used += firstPositiveNumber(usage, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  used += firstPositiveNumber(usage, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  used += firstPositiveNumber(usage, 'thought_tokens', 'thoughtTokens');
  used += firstPositiveNumber(usage, 'cached_write_tokens', 'cachedWriteTokens');
  used += firstPositiveNumber(usage, 'cached_read_tokens', 'cachedReadTokens');
  return Math.max(0, Math.floor(used));
}

/**
 * Build a ContextUsageData-compatible payload for the /context dialog.
 * Mirrors Java {@code GrokContextUsageBuilder}.
 */
export function buildGrokContextUsagePayload({
  usedTokens = 0,
  maxTokens = 200_000,
  model = '',
} = {}) {
  let used = Math.max(0, Number(usedTokens) || 0);
  const max = Math.max(1, Number(maxTokens) || 200_000);
  if (used > max) used = max;
  const free = Math.max(0, max - used);
  const percentage = Math.round((1000 * used) / max) / 10;

  return {
    success: true,
    totalTokens: used,
    maxTokens: max,
    rawMaxTokens: max,
    percentage,
    model: model || '',
    isAutoCompactEnabled: false,
    source: 'grok-synthesized',
    categories: [
      { name: 'Conversation', tokens: used, color: 'claude' },
      { name: 'Free space', tokens: free, color: 'inactive' },
    ],
    gridRows: [[
      {
        color: 'claude',
        isFilled: used > 0,
        categoryName: 'Conversation',
        tokens: used,
        percentage,
        squareFullness: used > 0 ? 1 : 0,
      },
      {
        color: 'inactive',
        isFilled: false,
        categoryName: 'Free space',
        tokens: free,
        percentage: Math.round((1000 * free) / max) / 10,
        squareFullness: free > 0 ? Math.min(1, free / max) : 0,
      },
    ]],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  };
}

/**
 * Simple spawn wrapper (headless secondary path / diagnostics).
 */
export function spawnGrok(args, env, cwd, onData) {
  return new Promise((resolve, reject) => {
    const bin = resolveGrokBinary();

    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onData) onData(s);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(`grok exited with code ${code}: ${stderr || stdout}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/**
 * Load models that support reasoning effort from the Grok CLI models cache.
 * This provides *dynamic* lookup instead of a static hardcoded set.
 * Returns array of model IDs (e.g. "grok-build") where supports_reasoning_effort === true.
 * Safe: returns [] if cache missing or unreadable.
 */
export function getGrokReasoningSupportedModels() {
  try {
    const cachePath = join(homedir(), '.grok', 'models_cache.json');
    if (!existsSync(cachePath)) {
      return [];
    }
    const raw = readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw);
    const models = data && (data.models || data);
    if (!models || typeof models !== 'object') {
      return [];
    }
    return Object.keys(models).filter((id) => {
      const entry = models[id];
      const info = entry && (entry.info || entry);
      return !!(info && info.supports_reasoning_effort === true);
    });
  } catch (e) {
    console.error('[Grok] Failed to read models_cache for reasoning supports:', e?.message || e);
    return [];
  }
}
