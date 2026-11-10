/** Resolve backend-owned supplier configuration without switching global defaults. */
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import {
  loadCodemossConfig, getClaudeRuntimeState, getCodexRuntimeState,
  isDangerousEnvVar, isWebviewControlledEnvVar,
} from './api-config.js';

const SPECIAL = new Set(['__local_settings_json__', '__cli_login__', '__codex_cli_login__']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function unavailable() {
  return Object.assign(new Error('The conversation supplier is unavailable or invalid. Select a configured supplier.'), { code: 'SESSION_SUPPLIER_UNAVAILABLE' });
}

export function resolveSessionSupplier(engine, supplierId, {
  config = loadCodemossConfig(), claudeState = getClaudeRuntimeState, codexState = getCodexRuntimeState,
} = {}) {
  if (supplierId === undefined || supplierId === null) return null;
  if (typeof supplierId !== 'string' || !supplierId.trim()) throw unavailable();
  if (SPECIAL.has(supplierId)) {
    const state = engine === 'claude' ? claudeState() : codexState();
    if (state.currentId !== supplierId || state.access === 'inactive') throw unavailable();
    return { id: supplierId, mode: state.access, revision: revision({ id: supplierId, mode: state.access }) };
  }
  const providers = config?.[engine]?.providers;
  const provider = object(providers) && Object.hasOwn(providers, supplierId) ? providers[supplierId] : null;
  if (!object(provider)) throw unavailable();
  return { id: supplierId, mode: 'managed', provider: structuredClone(provider), revision: revision({ supplierId, provider }) };
}

/** Credentials and model routing live only in the child copy, never process.env. */
export function buildSessionClaudeConfig(supplierId, { baseEnv = process.env, ...dependencies } = {}) {
  const selection = resolveSessionSupplier('claude', supplierId, dependencies);
  if (!selection || selection.mode !== 'managed') return null;
  const settings = selection.provider.settingsConfig;
  if (!object(settings) || !object(settings.env)) throw unavailable();
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CCGUI_CLI_LOGIN_AUTHORIZED$|CLAUDE_AGENT_SDK_VERSION$|CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST$)/i.test(key)
        || isWebviewControlledEnvVar(key)) delete env[key];
  }
  for (const [key, value] of Object.entries(settings.env)) {
    if (!isDangerousEnvVar(key) && !isWebviewControlledEnvVar(key) && typeof value === 'string') env[key] = value;
  }
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY && !settings.apiKeyHelper
      && !['BEDROCK', 'VERTEX', 'FOUNDRY'].some(name => ['1', 'true'].includes(String(env[`CLAUDE_CODE_USE_${name}`]).toLowerCase()))) {
    throw unavailable();
  }
  env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  env.USER_TYPE = 'external';
  if (!['BEDROCK', 'VERTEX', 'FOUNDRY'].some(name => ['1', 'true'].includes(String(env[`CLAUDE_CODE_USE_${name}`]).toLowerCase()))) {
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  }
  return { settings, env, revision: selection.revision };
}

/** Inline settings also fence cloud routing, where host-managed stripping is disabled. */
export function buildSessionClaudeSettingsOverride(supplier, override) {
  if (!supplier) return override;
  const env = {};
  for (const key of [
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL',
    'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
    'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'GCLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS',
  ]) env[key] = supplier.env[key] ?? '';
  for (const [key, value] of Object.entries(supplier.settings.env)) {
    if (!isDangerousEnvVar(key) && !isWebviewControlledEnvVar(key) && typeof value === 'string') env[key] = value;
  }
  return { ...override, apiKeyHelper: supplier.settings.apiKeyHelper || '', env: { ...env, ...override.env } };
}

/** Keep the shared history home, using native per-thread configuration overrides. */
export function buildSessionCodexConfig(supplierId, { baseEnv = process.env, ...dependencies } = {}) {
  const selection = resolveSessionSupplier('codex', supplierId, dependencies);
  if (!selection) return null;
  if (selection.mode !== 'managed') return { authMode: 'cli_login', providerRevision: selection.revision };
  try {
    const config = parse(selection.provider.configToml || '', { integersAsBigInt: 'asNeeded' });
    if (Object.hasOwn(config, 'mcp_servers') || Object.hasOwn(config, 'skills')) throw unavailable();
    const auth = JSON.parse(selection.provider.authJson || '{}');
    const selected = config.model_provider ?? 'openai';
    if (typeof selected !== 'string' || !selected.trim()) throw unavailable();
    const entry = config.model_providers?.[selected];
    if ((entry !== undefined && !object(entry)) || (entry === undefined && selected !== 'openai')) throw unavailable();
    let apiKey = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : '';
    if (!apiKey && entry?.env_key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.env_key) && !isDangerousEnvVar(entry.env_key)) {
      apiKey = baseEnv[entry.env_key] || '';
    }
    if (!apiKey) throw unavailable();
    // A dedicated child-only key prevents the global auth.json from selecting another supplier.
    const providerId = 'codemoss_session';
    const providerEntry = entry ? { ...entry } : { name: 'OpenAI', wire_api: 'responses' };
    providerEntry.env_key = 'CODEX_API_KEY';
    providerEntry.requires_openai_auth = false;
    delete config.model_aliases;
    delete config.model_provider;
    config.model_providers = { [providerId]: providerEntry };
    return {
      authMode: 'managed', apiKey, providerRevision: selection.revision,
      extraConfig: config, modelProvider: providerId,
    };
  } catch {
    // Parser diagnostics can contain credentials from the source text.
    throw unavailable();
  }
}

/** Resolve plugin model aliases from this supplier, never the globally selected profile. */
export function resolveSessionCodexModel(supplierId, model, dependencies = {}) {
  if (!model) return model;
  const selection = resolveSessionSupplier('codex', supplierId, dependencies);
  if (!selection || selection.mode !== 'managed') return model;
  try {
    const aliases = parse(selection.provider.configToml || '').model_aliases;
    const alias = object(aliases) && Object.hasOwn(aliases, model.trim()) ? aliases[model.trim()] : null;
    return typeof alias === 'string' && alias.trim() ? alias.trim() : model;
  } catch {
    throw unavailable();
  }
}
