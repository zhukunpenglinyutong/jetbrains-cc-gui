/**
 * Discover Grok models from ~/.grok/config.toml profiles and models_cache.json.
 *
 * Grok CLI `-m` must be a **config profile name** (`[model."name"]`) when using
 * custom base_url/api_key. Dumping the entire models_cache (often a third-party
 * OpenAI-compatible gateway catalog with third-party model ids) into the picker
 * is wrong — those ids bypass profile routing.
 *
 * Priority:
 *  1. Profiles from config.toml (always preferred when present)
 *  2. models_cache.json (official / bare API catalogs, only when no profiles)
 *  3. Static last-resort fallbacks
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveGrokDir() {
  const env = process.env.GROK_HOME;
  if (env && String(env).trim()) return String(env).trim();
  return join(homedir(), '.grok');
}

export function parseModelsCacheJson(jsonText) {
  const models = [];
  const seen = new Set();
  try {
    const data = JSON.parse(jsonText);
    const modelsObj = data?.models || (typeof data === 'object' && !Array.isArray(data) ? data : null);
    if (modelsObj && typeof modelsObj === 'object') {
      for (const [id, entry] of Object.entries(modelsObj)) {
        if (!id || seen.has(id)) continue;
        // Skip scalar metadata keys (e.g. `fetched_at`) that appear in
        // root-map layouts without a `models` wrapper.
        if (!entry || typeof entry !== 'object') continue;
        const raw = entry.info && typeof entry.info === 'object' ? entry.info : entry;
        if (raw.hidden === true) continue;
        seen.add(id);
        models.push({
          id,
          label: raw.name || raw.id || id,
          description: raw.description || raw.model || id,
        });
      }
    }
  } catch {
    // Ignore JSON parse errors
  }
  return { models, seen };
}

/**
 * Extract the body of a TOML section, line-based so a top-level `[` inside a
 * section body (e.g. an unindented multi-line array) cannot truncate it early.
 * Returns null when the section is absent.
 */
function extractTomlSection(src, sectionName) {
  const lines = String(src).split('\n');
  let inSection = false;
  let found = false;
  const body = [];
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      if (inSection) break;
      inSection = header[1].trim() === sectionName;
      found = found || inSection;
      continue;
    }
    if (inSection) body.push(line);
  }
  return found ? body.join('\n') : null;
}

export function parseGrokProfilesFromToml(tomlText, seenSet = new Set()) {
  const models = [];
  let defaultModel = null;
  const src = String(tomlText || '');

  // Grok keeps `default` inside the `[models]` section. Restrict the match to
  // that section (falling back to the top-level region before the first
  // header) so a `default = "..."` key inside a [model.*] profile or an
  // unrelated section is not misread as the global default.
  const modelsBody = extractTomlSection(src, 'models');
  const defaultScope = modelsBody != null
    ? modelsBody
    : src.split(/^\s*\[/m)[0];
  const defaultMatch = defaultScope.match(/^\s*default\s*=\s*"([^"]+)"/m);
  if (defaultMatch) {
    defaultModel = defaultMatch[1].trim();
  }

  const sectionRe = /\[model\.(?:"([^"]+)"|([a-zA-Z0-9_-]+))\]([\s\S]*?)(?=\n\[|\s*$)/g;
  let match;
  while ((match = sectionRe.exec(src)) !== null) {
    const id = (match[1] || match[2] || '').trim();
    if (!id || seenSet.has(id)) continue;
    seenSet.add(id);
    const body = match[3] || '';
    const nestedModel = body.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const nameMatch = body.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const nestedId = nestedModel ? nestedModel[1].trim() : '';
    const displayName = nameMatch ? nameMatch[1].trim() : '';
    models.push({
      id,
      // Prefer explicit display name, then nested upstream model id, then profile id.
      label: displayName || nestedId || id,
      description: nestedId || id,
    });
  }

  return { models, defaultModel };
}

/** Static last-resort list when neither profiles nor cache exist. */
export const GROK_STATIC_FALLBACK_MODELS = [
  { id: 'grok-4.6', label: 'Grok 4.6', description: "SpaceXAI's new frontier model" },
  { id: 'grok-3', label: 'Grok 3', description: 'xAI Grok 3' },
  { id: 'grok-2', label: 'Grok 2', description: 'xAI Grok 2' },
  { id: 'grok-beta', label: 'Grok Beta', description: 'xAI Grok Beta' },
];

/**
 * Pure merge used by listModels (and tests): prefer profiles over the raw
 * API catalog dump.
 */
export function resolveGrokPickerModels({ profileModels = [], cacheModels = [], defaultModel = null } = {}) {
  const profiles = Array.isArray(profileModels) ? profileModels : [];
  const cache = Array.isArray(cacheModels) ? cacheModels : [];

  if (profiles.length > 0) {
    // Enrich profile labels from cache when the same id exists and the profile
    // still shows a bare id as its label.
    const cacheById = new Map(cache.map((m) => [m.id, m]));
    const models = profiles.map((profile) => {
      const fromCache = cacheById.get(profile.id);
      if (!fromCache) return profile;
      const labelIsBareId = !profile.label || profile.label === profile.id;
      if (!labelIsBareId) return profile;
      return {
        ...profile,
        label: fromCache.label || profile.label,
        description: profile.description || fromCache.description,
      };
    });
    return {
      models,
      defaultModel: defaultModel || profiles[0].id,
    };
  }

  if (cache.length > 0) {
    return {
      models: cache,
      defaultModel: defaultModel || cache[0].id,
    };
  }

  return {
    models: [...GROK_STATIC_FALLBACK_MODELS],
    defaultModel: defaultModel || 'grok-4.6',
  };
}

export function listModels() {
  const grokDir = resolveGrokDir();
  const cachePath = join(grokDir, 'models_cache.json');
  const configPath = join(grokDir, 'config.toml');

  let cacheModels = [];
  let profileModels = [];
  let defaultModel = null;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = parseGrokProfilesFromToml(raw, new Set());
      profileModels = parsed.models;
      if (parsed.defaultModel) defaultModel = parsed.defaultModel;
    } catch (e) {
      console.error('[Grok Models] Failed to read config.toml:', e?.message || e);
    }
  }

  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, 'utf8');
      const { models } = parseModelsCacheJson(raw);
      cacheModels = models;
    } catch (e) {
      console.error('[Grok Models] Failed to read models_cache.json:', e?.message || e);
    }
  }

  const resolved = resolveGrokPickerModels({
    profileModels,
    cacheModels,
    defaultModel,
  });

  const payload = {
    success: true,
    models: resolved.models,
    defaultModel: resolved.defaultModel,
  };

  console.log(JSON.stringify(payload));
  return payload;
}
