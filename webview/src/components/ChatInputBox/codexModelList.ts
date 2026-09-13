import type { ModelInfo } from './types';

/**
 * Build the Codex model picker list by merging three layers (deduped by id,
 * first occurrence wins):
 *
 *  1. Plugin custom models (settings / localStorage)
 *  2. Dynamic catalog from `get_cli_models` (config.toml `model` +
 *     `model_catalog_json`; backend pins the config default first)
 *  3. Built-in `CODEX_MODELS` fallback (Sol / Terra / Luna / 5.5 / 5.4)
 *
 * Always keep built-ins so custom providers that only surface a single default
 * (e.g. `model = "gpt-5.5"`) still expose the full static lineup, while catalog
 * / custom ids (e.g. kimi-k3) remain selectable.
 */
export function buildCodexModelList(
  catalogModels: ModelInfo[],
  customModels: ModelInfo[],
  builtInModels: ModelInfo[] = [],
): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of [...customModels, ...catalogModels, ...builtInModels]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
