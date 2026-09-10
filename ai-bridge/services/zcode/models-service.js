/**
 * ZCode model catalog for the picker.
 *
 * Models are read from the desktop client's provider registry
 * (~/.zcode/v2/config.json), restricted to the channel currently in effect
 * (setting.json providerFamilyDomain + modelProviderFamilySelectedKeys), so
 * the picker mirrors what the ZCode client itself would bill against.
 * A small static list is the offline fallback.
 */

import {
  readZcodeConfig,
  readZcodeSettings,
  resolveActiveProvider,
  providerModels,
} from './zcode-config.js';

/** Static last-resort list when no client config is readable. */
export const ZCODE_STATIC_FALLBACK_MODELS = [
  { id: 'GLM-5.3', label: 'GLM-5.3', description: 'ZCode coding model' },
  { id: 'GLM-5.3-Flash', label: 'GLM-5.3 Flash', description: 'ZCode fast coding model' },
  { id: 'GLM-5-Turbo', label: 'GLM-5 Turbo', description: 'ZCode coding model' },
];

/**
 * Pure resolution (testable): pick the picker model list from config.
 */
export function resolveZcodePickerModels({ config = null, settings = null } = {}) {
  const active = resolveActiveProvider(config, settings);
  if (!active) {
    return { models: ZCODE_STATIC_FALLBACK_MODELS, defaultModel: ZCODE_STATIC_FALLBACK_MODELS[0].id };
  }
  const models = providerModels(active);
  if (models.length === 0) {
    return { models: ZCODE_STATIC_FALLBACK_MODELS, defaultModel: ZCODE_STATIC_FALLBACK_MODELS[0].id };
  }
  return { models, defaultModel: models[0].id };
}

/**
 * Print {success, models, defaultModel} for channel-manager listModels.
 */
export function listModels() {
  try {
    const config = readZcodeConfig();
    const settings = readZcodeSettings();
    if (!config) {
      const { models, defaultModel } = resolveZcodePickerModels({});
      console.log(JSON.stringify({ success: true, models, defaultModel, offline: true }));
      return;
    }
    const { models, defaultModel } = resolveZcodePickerModels({ config, settings });
    console.log(JSON.stringify({ success: true, models, defaultModel }));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: err?.message || String(err),
      models: ZCODE_STATIC_FALLBACK_MODELS,
      defaultModel: ZCODE_STATIC_FALLBACK_MODELS[0].id,
    }));
  }
}
