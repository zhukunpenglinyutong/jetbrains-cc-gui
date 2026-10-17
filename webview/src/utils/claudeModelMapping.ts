import { STORAGE_KEYS } from '../types/provider';

/**
 * Claude model mapping configuration.
 */
export interface ClaudeModelMapping {
  main?: string;
  fable?: string;
  haiku?: string;
  sonnet?: string;
  opus?: string;
  fableName?: string;
  haikuName?: string;
  sonnetName?: string;
  opusName?: string;
  [key: string]: string | undefined;
}

/** Parse only model ids and names from a provider's settings.env payload. */
export function parseClaudeModelMappingEnv(raw: unknown): ClaudeModelMapping {
  const env = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const mapping: ClaudeModelMapping = {};
  const copy = (key: string, envKey: string) => {
    if (typeof env[envKey] === 'string' && (env[envKey] as string).trim()) {
      mapping[key] = (env[envKey] as string).trim();
    }
  };
  copy('main', 'ANTHROPIC_MODEL');
  for (const role of ['sonnet', 'opus', 'fable', 'haiku']) {
    const envKey = `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`;
    copy(role, envKey);
    copy(`${role}Name`, `${envKey}_NAME`);
  }
  return mapping;
}

/** Display names are independent from the model id used for API routing. */
export function resolveClaudeModelMappingLabel(
  key: string | undefined,
  mapping: ClaudeModelMapping,
): string | undefined {
  const roleModel = key ? mapping[key]?.trim() : undefined;
  if (roleModel) return mapping[`${key}Name`]?.trim() || roleModel;
  return mapping.main?.trim() || undefined;
}

/**
 * Read the Claude model mapping.
 */
export function readClaudeModelMapping(): ClaudeModelMapping {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);
    if (!stored) {
      return {};
    }
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? parsed as ClaudeModelMapping : {};
  } catch {
    return {};
  }
}

/**
 * Check whether the mapping contains at least one valid model value.
 */
function hasMappingValue(mapping: ClaudeModelMapping): boolean {
  return Object.values(mapping).some(value => value && value.trim().length > 0);
}

/**
 * Maps built-in Claude model ids to their mapping key. Models not listed here
 * fall back to `mapping.main`.
 */
const MODEL_KEY_MAP: Record<string, string> = {
  'claude-fable-5-1': 'fable',
  'claude-fable-5': 'fable',
  'claude-sonnet-5-5': 'sonnet',
  'claude-sonnet-5': 'sonnet',
  'claude-sonnet-4-7': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-5-5': 'opus',
  'claude-opus-5': 'opus',
  'claude-opus-4-8': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-haiku-4-5': 'haiku',
};

/**
 * Apply the Claude model mapping to a built-in model entry: keeps its id
 * (unique key — the CLI resolves it to the real model via settings), but
 * rewrites the label to the configured display name, or the mapped model id
 * when no separate display name exists.
 * Mirrors ButtonArea's applyModelMapping, extracted for reuse by the Commit AI
 * settings panel so both surfaces show the same model list.
 */
export function applyClaudeModelMapping<T extends { id: string; label: string }>(
  model: T,
  mapping: ClaudeModelMapping,
): T {
  const key = MODEL_KEY_MAP[model.id];
  const resolvedMapping = resolveClaudeModelMappingLabel(key, mapping);
  if (resolvedMapping) {
    const actualModel = String(resolvedMapping).trim();
    if (actualModel.length > 0) {
      // Keep the original id as the unique identifier; only change the label.
      return { ...model, label: actualModel };
    }
  }
  return model;
}

/**
 * Write the Claude model mapping and proactively notify listeners in the same tab to refresh.
 */
export function writeClaudeModelMapping(mapping: ClaudeModelMapping): void {
  try {
    if (hasMappingValue(mapping)) {
      localStorage.setItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING, JSON.stringify(mapping));
    } else {
      localStorage.removeItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);
    }

    // localStorage writes in the same tab do not trigger the native storage event, so dispatch one manually here.
    window.dispatchEvent(new CustomEvent('localStorageChange', {
      detail: { key: STORAGE_KEYS.CLAUDE_MODEL_MAPPING },
    }));
  } catch {
    // Gracefully degrade when localStorage is unavailable or the write fails
  }
}
