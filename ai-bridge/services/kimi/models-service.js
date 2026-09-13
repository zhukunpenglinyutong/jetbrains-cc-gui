/**
 * Discover Kimi models from ~/.kimi-code/config.toml (and legacy homes).
 * Headless `kimi` has no `models` subcommand; aliases live under [models."..."].
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function resolveKimiConfigPaths() {
  const home = process.env.KIMI_CODE_HOME
    || process.env.KIMI_HOME
    || join(homedir(), '.kimi-code');
  const candidates = [
    join(home, 'config.toml'),
    join(homedir(), '.kimi-code', 'config.toml'),
    join(homedir(), '.kimi', 'config.toml'),
  ];
  return candidates.filter((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
}

/**
 * Minimal TOML extractors for:
 *   default_model = "..."
 *   [models."alias"]
 *   display_name = "..."
 */
export function parseKimiModelsFromToml(text) {
  const models = [];
  const seen = new Set();
  let defaultModel = null;

  const defaultMatch = String(text || '').match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  if (defaultMatch) {
    defaultModel = defaultMatch[1].trim();
  }

  const sectionRe = /\[models\."([^"]+)"\]([\s\S]*?)(?=\n\[|\s*$)/g;
  let match;
  while ((match = sectionRe.exec(text)) !== null) {
    const id = match[1].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const body = match[2] || '';
    const display = body.match(/^\s*display_name\s*=\s*"([^"]+)"/m);
    const nestedModel = body.match(/^\s*model\s*=\s*"([^"]+)"/m);
    models.push({
      id,
      label: (display && display[1].trim()) || id,
      description: (nestedModel && nestedModel[1].trim()) || id,
    });
  }

  if (defaultModel && !seen.has(defaultModel)) {
    models.unshift({
      id: defaultModel,
      label: defaultModel,
      description: 'default_model',
    });
  }

  // Prefer default first when present in list.
  if (defaultModel) {
    models.sort((a, b) => {
      if (a.id === defaultModel) return -1;
      if (b.id === defaultModel) return 1;
      return 0;
    });
  }

  return { defaultModel, models };
}

/**
 * Prints JSON model list for channel-manager listModels.
 */
export function listModels() {
  const paths = resolveKimiConfigPaths();
  let models = [];
  let defaultModel = null;

  for (const path of paths) {
    try {
      const text = readFileSync(path, 'utf8');
      const parsed = parseKimiModelsFromToml(text);
      if (parsed.models.length > 0) {
        models = parsed.models;
        defaultModel = parsed.defaultModel;
        break;
      }
    } catch {
      // try next path
    }
  }

  if (models.length === 0) {
    models = [
      { id: 'auto', label: 'Kimi Auto', description: 'Use Kimi CLI default model' },
    ];
  }

  console.log(JSON.stringify({
    success: true,
    provider: 'kimi',
    defaultModel,
    models,
  }));
}
