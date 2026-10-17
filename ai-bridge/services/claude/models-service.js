import { loadClaudeSettings } from '../../config/api-config.js';

const baseId = (id) => id.trim().replace(/\[1m\]$/i, '');

/** Only model ids and display names cross the bridge; never credentials. */
export function parseClaudeModelMapping(settings) {
  const env = settings?.env;
  const mapping = {};
  const copy = (key, envKey) => {
    if (typeof env?.[envKey] === 'string' && env[envKey].trim()) {
      mapping[key] = env[envKey].trim();
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

/** Read the same settings.json model picker used by Claude Code / cc-switch. */
export function parseClaudeModelPicker(settings) {
  const picker = settings?.modelPicker;
  const models = [];
  const seen = new Set();
  if (Array.isArray(picker?.options)) {
    for (const option of picker.options) {
      if (typeof option?.model !== 'string') continue;
      // The webview stores the base id and applies its 1M toggle on send.
      const id = baseId(option.model);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        supports1MContext: /\[1m\]$/i.test(option.model.trim()),
        label: typeof option.label === 'string' && option.label.trim() ? option.label.trim() : id,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      });
    }
  }
  const env = settings?.env;
  const configuredDefault = [settings?.model, env?.ANTHROPIC_MODEL, env?.ANTHROPIC_DEFAULT_SONNET_MODEL]
    .find((value) => typeof value === 'string' && value.trim());
  const defaultId = configuredDefault ? baseId(configuredDefault) : null;
  return {
    models,
    replaceBuiltInOptions: Array.isArray(picker?.options) && picker.replaceBuiltInOptions === true,
    defaultModel: models.some((model) => model.id === defaultId) ? defaultId : models[0]?.id ?? null,
  };
}

export function listModels() {
  const settings = loadClaudeSettings();
  console.log(JSON.stringify({
    success: true,
    provider: 'claude',
    ...parseClaudeModelPicker(settings),
    modelMapping: parseClaudeModelMapping(settings),
  }));
}
