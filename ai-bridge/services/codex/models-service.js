/**
 * Discover Codex models from ~/.codex/config.toml and the optional
 * model_catalog_json file (cc-switch / codex model catalog format).
 *
 * Headless `codex` has no `models` subcommand; the CLI's own model picker
 * reads the same config + catalog, so parsing them here keeps the GUI list
 * identical to what `codex` would show.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';

function resolveCodexConfigPath() {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(home, 'config.toml');
}

/**
 * Extract a top-level scalar string key from TOML text.
 * Only the region before the first `[section]` header is considered, so
 * same-named keys inside `[model_providers.x]` tables are never matched.
 * Tolerates single-quoted (literal) and double-quoted strings.
 */
function extractTopLevelString(tomlText, key) {
  const topLevel = String(tomlText || '').split(/^\s*\[/m)[0];
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm');
  const reLiteral = new RegExp(`^\\s*${key}\\s*=\\s*'([^']*)'`, 'm');
  const match = topLevel.match(re) || topLevel.match(reLiteral);
  return match ? match[1].trim() : null;
}

/**
 * Minimal TOML extractors for the codex config's top-level keys:
 *   model = "..."
 *   model_provider = "..."
 *   model_catalog_json = "..."
 */
export function parseCodexConfigToml(text) {
  return {
    model: extractTopLevelString(text, 'model'),
    modelProvider: extractTopLevelString(text, 'model_provider'),
    modelCatalogJson: extractTopLevelString(text, 'model_catalog_json'),
  };
}

/**
 * Parse a model catalog JSON file defensively. Accepted shapes:
 *   [ {...}, ... ]                 (root array)
 *   { "models": [ {...}, ... ] }   (codex CLI / cc-switch format)
 *   { "<id>": {...}, ... }         (id -> meta map)
 *
 * Entry mapping: id = slug || id || map key, label = display_name || name || id,
 * description = description. Entries whose `visibility` is present and not
 * "list" are hidden by the codex CLI picker, so they are dropped here too.
 * Entries are sorted by `priority` descending when present (stable otherwise).
 */
export function parseModelCatalogJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  let entries = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.models)) {
      entries = parsed.models;
    } else {
      entries = Object.entries(parsed)
        .filter(([, meta]) => meta && typeof meta === 'object')
        .map(([key, meta]) => ({ ...meta, slug: meta.slug || key }));
    }
  }

  const models = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const rawId = typeof entry.slug === 'string' ? entry.slug : entry.id;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id)) continue;
    if (entry.visibility !== undefined && entry.visibility !== 'list') continue;
    seen.add(id);
    const displayName = typeof entry.display_name === 'string' ? entry.display_name
      : typeof entry.name === 'string' ? entry.name : null;
    models.push({
      id,
      label: (displayName && displayName.trim()) || id,
      description: typeof entry.description === 'string' && entry.description.trim()
        ? entry.description.trim()
        : undefined,
      priority: typeof entry.priority === 'number' ? entry.priority : null,
    });
  }

  models.sort((a, b) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity));
  return models.map(({ priority, ...model }) => model);
}

/** Official OpenAI provider ids for which the GUI's static list still applies. */
const OFFICIAL_PROVIDER_IDS = new Set(['openai', 'azure', 'azure-openai']);

/**
 * Prints JSON model list for channel-manager listModels.
 *
 * Merge rules (mirroring the codex CLI picker):
 * - catalog present            -> catalog entries (default model pinned first)
 * - no catalog, custom provider -> only the configured default model (the
 *                                  built-in GPT list does not apply to it)
 * - no catalog, official provider -> empty models + defaultModel; the frontend
 *                                  falls back to its static built-in list
 */
export function listModels() {
  try {
    const configPath = resolveCodexConfigPath();
    if (!existsSync(configPath)) {
      console.log(JSON.stringify({
        success: true,
        provider: 'codex',
        defaultModel: null,
        models: [],
      }));
      return;
    }

    const config = parseCodexConfigToml(readFileSync(configPath, 'utf8'));
    const defaultModel = config.model || null;

    let catalogModels = [];
    if (config.modelCatalogJson) {
      const catalogPath = isAbsolute(config.modelCatalogJson)
        ? config.modelCatalogJson
        : join(dirname(configPath), config.modelCatalogJson);
      try {
        catalogModels = parseModelCatalogJson(readFileSync(catalogPath, 'utf8'));
      } catch {
        catalogModels = [];
      }
    }

    let models;
    if (catalogModels.length > 0) {
      models = catalogModels;
      if (defaultModel && !models.some((m) => m.id === defaultModel)) {
        models.unshift({ id: defaultModel, label: defaultModel });
      }
      if (defaultModel) {
        models.sort((a, b) => {
          if (a.id === defaultModel) return -1;
          if (b.id === defaultModel) return 1;
          return 0;
        });
      }
    } else if (config.modelProvider && !OFFICIAL_PROVIDER_IDS.has(config.modelProvider)) {
      models = defaultModel ? [{ id: defaultModel, label: defaultModel }] : [];
    } else {
      models = [];
    }

    console.log(JSON.stringify({
      success: true,
      provider: 'codex',
      defaultModel,
      models,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      provider: 'codex',
      error: error instanceof Error ? error.message : String(error),
      models: [],
    }));
  }
}
