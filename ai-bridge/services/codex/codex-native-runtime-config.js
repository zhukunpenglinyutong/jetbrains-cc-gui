/**
 * Native runtime configuration for the Codex app-server child process.
 *
 * Assembles the managed / cli_login launch parameters per design D5:
 *  - managed: the active provider's endpoint, credentials, and headers ride
 *    through a native model_providers entry plus the child env_key variable;
 *  - cli_login: the user's native auth (CODEX_HOME auth.json) stays
 *    authoritative — no credential values are injected, and empty values
 *    never overwrite anything;
 *  - both: the child environment keeps the buildCodexCliEnvironment rules
 *    (CODEX_* pollution removal, proxy opt-in, protected variables).
 *
 * Nothing in this module reads ~/.codex/auth.json or config.toml: the
 * app-server child owns native configuration reading, and the plugin only
 * passes launch parameters. A credential value never appears in returned
 * config strings or diagnostics — only in the child environment map.
 */

import { createHash } from 'node:crypto';

import { buildCodexCliEnvironment } from './codex-utils.js';

export const CODEX_NATIVE_AUTH_MODES = Object.freeze(['managed', 'cli_login']);

/** Child environment variable that carries the managed API key (env_key). */
export const CODEX_MANAGED_API_KEY_ENV = 'CODEX_API_KEY';

/** Id of the native model_providers entry assembled for managed providers. */
export const CODEX_MANAGED_PROVIDER_ID = 'codemoss_managed';
export const CODEX_PROJECT_DOC_FALLBACK = 'CLAUDE.md';

function normalizeAuthMode(authMode) {
  return CODEX_NATIVE_AUTH_MODES.includes(authMode) ? authMode : 'managed';
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Merge project fallback names for native instruction discovery. AGENTS.md is
 * discovered by Codex itself; this list only preserves the optional CLAUDE.md
 * fallback without reading or concatenating either file in the plugin.
 */
export function buildProjectDocFallbackConfig(extraConfig = null, fallbackNames = null) {
  const existing = Array.isArray(extraConfig?.project_doc_fallback_filenames)
    ? extraConfig.project_doc_fallback_filenames.filter((name) => typeof name === 'string')
    : [];
  const requested = Array.isArray(fallbackNames) ? fallbackNames : [];
  const merged = [...existing, ...requested, CODEX_PROJECT_DOC_FALLBACK]
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name, index, values) => values.indexOf(name) === index);
  return {
    ...(extraConfig ?? {}),
    project_doc_fallback_filenames: merged,
  };
}

/**
 * Assemble the app-server child launch parameters.
 *
 * @param {object} opts
 * @param {'managed'|'cli_login'} [opts.authMode] runtime access mode
 * @param {string|null} [opts.apiKey] managed provider credential (may be empty)
 * @param {string|null} [opts.baseUrl] managed provider endpoint (may be empty)
 * @param {string|null} [opts.providerLabel] friendly provider name
 * @param {Record<string,string>|null} [opts.headers] extra HTTP headers for the provider
 * @param {Record<string,string>|null} [opts.baseEnv] environment for the child
 * @param {object|null} [opts.extraConfig] additional native config entries merged in
 * @returns {{
 *   env: Record<string,string>,
 *   removedEnvKeys: string[],
 *   modelProvider: string|null,
 *   config: Record<string, unknown>|null,
 *   auth: {mode: string, credentialInjected: boolean, providerConfigured: boolean}
 * }}
 */
export function buildCodexNativeRuntime({
  authMode = 'managed',
  apiKey = null,
  baseUrl = null,
  providerLabel = null,
  headers = null,
  baseEnv = process.env,
  extraConfig = null,
  projectDocFallbackFilenames = null,
} = {}) {
  const mode = normalizeAuthMode(authMode);
  const nativeExtraConfig = buildProjectDocFallbackConfig(extraConfig, projectDocFallbackFilenames);
  const { cliEnv, removedKeys } = buildCodexCliEnvironment(baseEnv);

  // cli_login: native auth stays authoritative; empty values must never
  // overwrite it, so nothing is injected at all.
  if (mode === 'cli_login') {
    return {
      env: cliEnv,
      removedEnvKeys: removedKeys,
      modelProvider: null,
      config: nativeExtraConfig,
      auth: { mode, credentialInjected: false, providerConfigured: false },
    };
  }

  // managed: only a non-empty credential reaches the child env. An empty
  // apiKey must not clobber a value already present in the environment.
  let credentialInjected = false;
  if (hasValue(apiKey)) {
    cliEnv[CODEX_MANAGED_API_KEY_ENV] = apiKey.trim();
    credentialInjected = true;
  }

  let modelProvider = null;
  let config = null;
  const providerConfigured = Boolean(
    hasValue(apiKey) || hasValue(baseUrl) || (headers && Object.keys(headers).length > 0)
  );
  if (providerConfigured) {
    modelProvider = CODEX_MANAGED_PROVIDER_ID;
    const providerEntry = { name: 'Codemoss', wire_api: 'responses' };
    if (hasValue(providerLabel)) {
      providerEntry.name = providerLabel.trim();
    }
    if (hasValue(baseUrl)) {
      providerEntry.base_url = baseUrl.trim();
    }
    providerEntry.env_key = CODEX_MANAGED_API_KEY_ENV;
    if (headers && Object.keys(headers).length > 0) {
      providerEntry.http_headers = { ...headers };
    }
    config = {
      model_providers: {
        [CODEX_MANAGED_PROVIDER_ID]: providerEntry,
      },
      ...(nativeExtraConfig && Object.keys(nativeExtraConfig).length > 0 ? nativeExtraConfig : {}),
    };
  } else if (nativeExtraConfig && Object.keys(nativeExtraConfig).length > 0) {
    config = { ...nativeExtraConfig };
  }

  return {
    env: cliEnv,
    removedEnvKeys: removedKeys,
    modelProvider,
    config,
    auth: { mode, credentialInjected, providerConfigured },
  };
}

/**
 * Build the argv used to spawn the app-server transport.
 * The transport argv is fixed; per-request parameters travel through RPC.
 */
export function buildAppServerArgv(cliCommand) {
  return [...cliCommand, 'app-server', '--listen', 'stdio://'];
}

function hashCredential(value) {
  if (!hasValue(value)) {
    return 'absent';
  }
  return createHash('sha256').update(value.trim(), 'utf8').digest('hex').slice(0, 16);
}

function canonicalize(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable fingerprint of everything that requires rebuilding the app-server
 * child: auth mode, endpoint, provider identity/headers, credential, and the
 * native home. Ordinary per-turn settings (model, effort, collaboration mode,
 * approval policy, sandbox) deliberately do NOT participate — they travel
 * through RPC without a restart.
 *
 * The fingerprint never contains credential plaintext: the API key
 * contributes only a short salted hash.
 *
 * @param {object} opts same launch inputs as {@link buildCodexNativeRuntime}
 * @returns {string} hex fingerprint
 */
export function computeCodexRuntimeFingerprint({
  authMode = 'managed',
  apiKey = null,
  baseUrl = null,
  providerLabel = null,
  headers = null,
  codexHome = null,
  cliSource = null,
  developerInstructions = null,
  providerRevision = null,
  projectDocFallbackFilenames = null,
} = {}) {
  const material = {
    authMode: normalizeAuthMode(authMode),
    apiKeyHash: hashCredential(apiKey),
    baseUrl: hasValue(baseUrl) ? baseUrl.trim() : null,
    providerLabel: hasValue(providerLabel) ? providerLabel.trim() : null,
    headers: headers && Object.keys(headers).length > 0
      ? canonicalize(headers) : null,
    codexHome: hasValue(codexHome) ? codexHome.trim() : null,
    cliSource: hasValue(cliSource) ? cliSource.trim() : null,
    developerInstructionsHash: hashCredential(developerInstructions),
    providerRevision,
    projectDocFallbackFilenames: Array.isArray(projectDocFallbackFilenames)
      ? projectDocFallbackFilenames.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean)
      : null,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(material)), 'utf8')
    .digest('hex');
}
