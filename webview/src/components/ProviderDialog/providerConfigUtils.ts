import { CLAUDE_MODEL_MAPPING_ENV_KEYS } from '../../types/provider';

const trimString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const readHaikuModel = (env: Record<string, unknown>): string => (
  trimString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
);

export const readFableModel = (env: Record<string, unknown>): string => (
  trimString(env.ANTHROPIC_DEFAULT_FABLE_MODEL)
);

export function normalizeProviderEnvForSave(
  env: Record<string, unknown>,
  options: { stripAllModelMappings?: boolean } = {}
): Record<string, unknown> {
  const nextEnv = { ...env };

  if (options.stripAllModelMappings) {
    for (const key of CLAUDE_MODEL_MAPPING_ENV_KEYS) {
      delete nextEnv[key];
    }
    return nextEnv;
  }

  const mainModel = trimString(nextEnv.ANTHROPIC_MODEL);
  if (!mainModel) {
    delete nextEnv.ANTHROPIC_MODEL;
    return nextEnv;
  }

  const specificModels = [
    trimString(nextEnv.ANTHROPIC_DEFAULT_FABLE_MODEL),
    trimString(nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    trimString(nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL),
    trimString(nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL),
  ].filter(Boolean);

  if (specificModels.length === 0 || specificModels.every(model => model === mainModel)) {
    delete nextEnv.ANTHROPIC_MODEL;
  }

  return nextEnv;
}

export function sanitizeProviderJsonConfig(
  rawJsonConfig: string,
  options: { stripAllModelMappings?: boolean } = {}
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = rawJsonConfig ? JSON.parse(rawJsonConfig) : {};
  } catch {
    return rawJsonConfig;
  }
  const prevEnv = parsed.env && typeof parsed.env === 'object'
    ? parsed.env as Record<string, unknown>
    : {};
  const nextEnv = normalizeProviderEnvForSave(prevEnv, options);

  const nextConfig = Object.keys(nextEnv).length > 0
    ? { ...parsed, env: nextEnv }
    : Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'env'));

  return JSON.stringify(nextConfig, null, 2);
}
