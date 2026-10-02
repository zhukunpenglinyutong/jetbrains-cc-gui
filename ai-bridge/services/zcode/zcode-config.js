/**
 * ZCode environment resolution: zcode.cjs location, data directory, and
 * provider credentials sourced from the ZCode desktop client's own config.
 *
 * The ZCode app-server is a Node entry point bundled inside the desktop
 * client (resources/glm/zcode.cjs), not a PATH binary, so discovery is by
 * well-known install locations with ZCODE_CLI_PATH as an explicit override.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Read + parse a JSON file; null on any failure. */
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function nonBlank(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * ZCode data root. The desktop client can relocate its data via the
 * dataBaseDir field in ~/.zcode/v2/setting.json; default is ~/.zcode.
 */
export function resolveZcodeHome(baseHome = homedir()) {
  const envHome = process.env.ZCODE_HOME;
  if (nonBlank(envHome)) return envHome.trim();

  const defaultHome = join(baseHome, '.zcode');
  const setting = readJsonFile(join(defaultHome, 'v2', 'setting.json'));
  if (setting && nonBlank(setting.dataBaseDir)) {
    return resolve(setting.dataBaseDir.trim());
  }
  return defaultHome;
}

/**
 * Locate the app-server entry (zcode.cjs) bundled with the desktop client.
 */
export function resolveZcodeCliPath(platform = process.platform, env = process.env) {
  const explicit = env.ZCODE_CLI_PATH;
  if (nonBlank(explicit) && existsSync(explicit.trim())) {
    return explicit.trim();
  }

  const candidates = [];
  if (platform === 'darwin') {
    candidates.push('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const pf = env['ProgramFiles'];
    const pf86 = env['ProgramFiles(x86)'];
    if (nonBlank(local)) candidates.push(join(local, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    if (nonBlank(pf)) candidates.push(join(pf, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    if (nonBlank(pf86)) candidates.push(join(pf86, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
  } else {
    candidates.push('/opt/ZCode/app/resources/glm/zcode.cjs');
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return nonBlank(explicit) ? explicit.trim() : null;
}

/**
 * Fallback: the desktop client's own personal provider registry
 * (v2/provider_config.json, also exported via ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).
 * Recent ZCode builds keep credentials there and never create v2/config.json,
 * so without this the plugin finds no provider and the app-server falls back
 * to a stale OAuth chain. Converted into the same provider-map shape the
 * legacy config.json uses.
 */
function readNativeProviderRegistry(zcodeHome) {
  const envPath = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  const candidates = [];
  if (nonBlank(envPath)) candidates.push(envPath.trim());
  candidates.push(join(zcodeHome, 'v2', 'provider_config.json'));
  for (const path of candidates) {
    const data = readJsonFile(path);
    const rules = data?.config?.providerConfigRules?.providerRules;
    if (Array.isArray(rules)) return rules;
  }
  return null;
}

/** Known builtin model ids per coding-plan template, used when the builtin
 *  registry file is unavailable. Limited metadata is better than no provider. */
const NATIVE_TEMPLATE_FALLBACK_MODELS = {
  'zai-api': ['GLM-5.3', 'GLM-5.3-Flash'],
  'bigmodel-api': ['GLM-5.3', 'GLM-5.3-Flash'],
};

function readBuiltinTemplateModels() {
  const envPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  if (!nonBlank(envPath)) return {};
  const data = readJsonFile(envPath.trim());
  const templates = data?.config?.providerConfigRules?.templateRules;
  const out = {};
  if (Array.isArray(templates)) {
    for (const t of templates) {
      if (t?.templateId && Array.isArray(t.config?.builtinModelIds)) {
        out[t.templateId] = t.config.builtinModelIds;
      }
    }
  }
  return out;
}

function convertNativeRegistry(rules) {
  const templateModels = readBuiltinTemplateModels();
  const providers = {};
  for (const rule of rules) {
    if (!rule || rule.enabled === false || typeof rule.providerId !== 'string') continue;
    const access = rule.config?.access || {};
    const api = rule.config?.api || {};
    if (!nonBlank(access.apiKey)) continue;
    const modelIds = templateModels[rule.templateId]
      || NATIVE_TEMPLATE_FALLBACK_MODELS[rule.templateId]
      || [];
    const models = {};
    for (const id of modelIds) models[id] = { name: id };
    providers[rule.providerId] = {
      enabled: true,
      kind: String(api.type || '').startsWith('anthropic') ? 'anthropic' : 'openai',
      name: nonBlank(rule.providerName) ? rule.providerName : rule.providerId,
      options: {
        baseURL: nonBlank(api.baseUrl) ? api.baseUrl.trim() : '',
        apiKey: access.apiKey,
      },
      models,
    };
  }
  return Object.keys(providers).length > 0 ? { provider: providers } : null;
}

/**
 * v2 config.json (provider registry + credentials). Falls back to the desktop
 * client's native provider_config.json registry for engines that no longer
 * maintain the legacy file.
 */
export function readZcodeConfig(zcodeHome = resolveZcodeHome()) {
  const legacy = readJsonFile(join(zcodeHome, 'v2', 'config.json'));
  if (legacy) return legacy;
  const rules = readNativeProviderRegistry(zcodeHome);
  return rules ? convertNativeRegistry(rules) : null;
}

/** v2 setting.json (active channel selection). */
export function readZcodeSettings(zcodeHome = resolveZcodeHome()) {
  return readJsonFile(join(zcodeHome, 'v2', 'setting.json'));
}

/**
 * Resolve the provider entry the desktop client is currently billing against.
 *
 * setting.json pins the active family (providerFamilyDomain) and the selected
 * key inside that family (modelProviderFamilySelectedKeys[domain], shaped
 * "preset:<id>" / "coding-plan:<id>" / "team-plan:<id>"). Falls back to the
 * first enabled anthropic-kind provider with a usable key.
 */
export function resolveActiveProvider(config = readZcodeConfig(), settings = readZcodeSettings()) {
  const providers = config && typeof config.provider === 'object' ? config.provider : null;
  if (!providers) return null;

  const family = settings && nonBlank(settings.providerFamilyDomain)
    ? settings.providerFamilyDomain.trim()
    : null;
  const selectedKeys = settings && typeof settings.modelProviderFamilySelectedKeys === 'object'
    ? settings.modelProviderFamilySelectedKeys
    : {};

  const selectedRaw = family ? selectedKeys[family] : null;
  if (nonBlank(selectedRaw)) {
    // Selected keys carry a "<kind>:" prefix; the provider id follows it.
    const providerId = selectedRaw.includes(':')
      ? selectedRaw.slice(selectedRaw.indexOf(':') + 1)
      : selectedRaw;
    const entry = providers[providerId];
    if (entry && entry.enabled !== false) {
      return { providerId, ...normalizeProviderEntry(entry) };
    }
  }

  // Fallback: first enabled anthropic provider that can actually authenticate.
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!entry || entry.enabled === false || entry.kind !== 'anthropic') continue;
    const normalized = normalizeProviderEntry(entry);
    if (nonBlank(normalized.apiKey)) {
      return { providerId, ...normalized };
    }
  }
  return null;
}

function normalizeProviderEntry(entry) {
  const options = entry && typeof entry.options === 'object' ? entry.options : {};
  const models = entry && typeof entry.models === 'object' ? entry.models : {};
  return {
    kind: entry?.kind || '',
    name: entry?.name || '',
    baseURL: nonBlank(options.baseURL) ? options.baseURL.trim() : '',
    apiKey: nonBlank(options.apiKey) ? options.apiKey.trim() : '',
    models,
  };
}

/**
 * Models exposed by one provider entry, shaped for the model picker.
 * Captcha-gated plan gateways (zcode-plan hosts) cannot be driven headlessly.
 */
export function providerModels(entry) {
  if (!entry || !entry.models) return [];
  const out = [];
  for (const [modelId, def] of Object.entries(entry.models)) {
    const modalities = def && typeof def.modalities === 'object' ? def.modalities : {};
    const inputs = Array.isArray(modalities.input) ? modalities.input : [];
    out.push({
      id: modelId,
      label: (def && nonBlank(def.name)) ? def.name : modelId,
      description: entry.name || '',
      contextWindow: def?.limit?.context ?? null,
      maxOutput: def?.limit?.output ?? null,
      supportsImages: inputs.includes('image'),
    });
  }
  return out;
}

/**
 * Credential env for the app-server child process. When the active provider
 * authenticates via oauth (no inline apiKey), nothing is injected and the
 * app-server falls back to its own credential chain under ~/.zcode.
 */
export function buildZcodeCredentialEnv(active = resolveActiveProvider()) {
  if (!active || !nonBlank(active.apiKey) || !nonBlank(active.baseURL)) {
    return {};
  }
  const modelIds = Object.keys(active.models || {});
  return {
    ZCODE_BASE_URL: active.baseURL,
    ANTHROPIC_API_KEY: active.apiKey,
    ...(modelIds.length > 0 ? { ZCODE_MODEL: modelIds[0] } : {}),
  };
}

/**
 * Full environment for `node zcode.cjs app-server`.
 */
export function buildZcodeEnv(baseEnv = process.env) {
  return { ...baseEnv, ...buildZcodeCredentialEnv() };
}

/**
 * Build the full runtimeModel carrier for session/setModel + session/send.
 *
 * The app-server's own provider registry only knows the env-injected
 * credentials (exposed as provider "anthropic"); desktop-client channels like
 * "builtin:bigmodel-coding-plan" are unknown to it until a request carries the
 * complete provider definition. Omitting limit/modalities from the model defs
 * zeroes the context window server-side (breaks autocompact), so every model
 * of the provider is embedded in full.
 */
export function buildRuntimeModel(modelId, active = resolveActiveProvider()) {
  if (!active || !nonBlank(modelId)) return null;
  const models = Object.entries(active.models || {}).map(([id, def]) => ({
    modelId: id,
    label: (def && nonBlank(def.name)) ? def.name : id,
    contextWindow: def?.limit?.context ?? undefined,
    maxOutputTokens: def?.limit?.output ?? undefined,
    supportsImages: Array.isArray(def?.modalities?.input)
      ? def.modalities.input.includes('image')
      : undefined,
  }));
  if (models.length === 0) return null;
  return {
    revision: '0',
    generatedAt: Date.now(),
    model: { providerId: active.providerId, modelId },
    provider: {
      providerId: active.providerId,
      kind: 'anthropic',
      label: active.name || active.providerId,
      source: active.providerId.startsWith('builtin:') ? 'builtin' : 'custom',
      baseURL: active.baseURL || undefined,
      ...(active.apiKey ? { apiKey: { source: 'inline', value: active.apiKey } } : {}),
      models,
    },
  };
}
