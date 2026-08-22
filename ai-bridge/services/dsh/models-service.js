/**
 * DSH models service — the catalog is runtime-only, from the host's
 * `llm.models` RPC. Never spawns a host for the picker (aligned with
 * desktop-cc-gui: catalog / doctor must not spawn).
 */

import { connectExisting, runtimeSettingsFromEnv } from './supervisor.js';
import { defaultDshModel, flattenLlmModels, loadModels } from './session.js';

function withDefaultModel(models, defaultModel) {
  if (!defaultModel || models.some((model) => model.id === defaultModel)) {
    return models;
  }
  const [provider = 'unknown', ...modelParts] = defaultModel.split('/');
  const modelId = modelParts.join('/');
  if (!modelId) {
    return models;
  }
  return [
    {
      id: defaultModel,
      label: `${provider} / ${modelId}`,
      description: provider,
    },
    ...models,
  ];
}

function configuredDefaultFromDescribe(describe) {
  const provider = describe && typeof describe.provider === 'string' ? describe.provider : '';
  const model = describe && typeof describe.model === 'string' ? describe.model : '';
  return provider && model ? `${provider}/${model}` : null;
}

export async function listModels() {
  const settings = runtimeSettingsFromEnv();
  let configuredDefaultModel = null;
  try {
    const { client, describe } = await connectExisting(settings);
    configuredDefaultModel = configuredDefaultFromDescribe(describe);
    const catalog = await loadModels(client);
    const defaultModel = defaultDshModel(catalog, describe);
    const models = withDefaultModel(flattenLlmModels(catalog), defaultModel);
    console.log(JSON.stringify({
      success: true,
      provider: 'dsh',
      defaultModel,
      models,
    }));
  } catch (error) {
    // Host down / CLI missing: preserve the configured default from
    // host.describe when the probe reached a live host before failing. The
    // webview otherwise keeps its static Auto entry while showing why no
    // full catalog is available.
    console.log(JSON.stringify({
      success: true,
      provider: 'dsh',
      defaultModel: configuredDefaultModel,
      models: [],
      error: error.message,
    }));
  }
}
