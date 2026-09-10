import { toFiniteNumber } from "./format";

type AnyRecord = Record<string, any>;

function normalizeModelId(value: any) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function resolveModelId(model: any) {
  const id = normalizeModelId(model?.model_id);
  if (id) return id;
  return null;
}

function resolveModelName(model: any, fallback: any) {
  if (model?.model) return String(model.model);
  return fallback;
}

function buildBareModelNameIndex(models: any[]) {
  const bareNames = new Map();
  const weights = new Map();
  for (const model of models) {
    const name = typeof model?.name === "string" ? model.name.trim() : "";
    const key = normalizeModelId(name);
    if (!key || key.includes("/")) continue;
    const weight = Math.max(0, toFiniteNumber(model?.weight) ?? 0);
    if (!bareNames.has(key) || weight >= (weights.get(key) || 0)) {
      bareNames.set(key, name);
      weights.set(key, weight);
    }
  }
  return bareNames;
}

function resolveAggregateModelIdentity(name: string, bareNames: Map<string, string>) {
  const normalized = normalizeModelId(name);
  if (!normalized) return null;
  const slash = normalized.lastIndexOf("/");
  if (slash > 0) {
    const suffix = normalized.slice(slash + 1);
    if (bareNames.has(suffix)) {
      return { key: suffix, name: bareNames.get(suffix) };
    }
  }
  return { key: normalized, name };
}

export function resolveDisplayTokens(totals: any, fallback = 0) {
  const billableTokens = toFiniteNumber(totals?.billable_total_tokens);
  const totalTokens = toFiniteNumber(totals?.total_tokens);
  if (billableTokens != null && billableTokens > 0) return billableTokens;
  if (totalTokens != null && totalTokens > 0) return totalTokens;
  return billableTokens ?? totalTokens ?? fallback;
}

export function buildFleetData(modelBreakdown: any, { copyFn }: AnyRecord = {}) {
  const safeCopy = typeof copyFn === "function" ? copyFn : (key: string) => key;
  const sources: any[] = Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [];
  const normalizedSources = sources.flatMap((entry) => {
    const totalTokens = resolveDisplayTokens(entry?.totals);
    const totalCost = toFiniteNumber(entry?.totals?.total_cost_usd) ?? 0;
    const normalized = {
      source: entry?.source,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
      totalCost: Number.isFinite(totalCost) ? totalCost : 0,
      inputTokens: Math.max(0, toFiniteNumber(entry?.totals?.input_tokens) ?? 0),
      cacheRead: Math.max(0, toFiniteNumber(entry?.totals?.cached_input_tokens) ?? 0),
      cacheCreate: Math.max(0, toFiniteNumber(entry?.totals?.cache_creation_input_tokens) ?? 0),
      models: Array.isArray(entry?.models) ? entry.models : [],
    };
    return normalized.totalTokens > 0 ? [normalized] : [];
  });

  if (!normalizedSources.length) return [];

  const grandTotal = normalizedSources.reduce((acc, entry) => acc + entry.totalTokens, 0);

  return normalizedSources
    .slice()
    .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
    .map((entry: any) => {
      const label = entry.source
        ? String(entry.source).toUpperCase()
        : safeCopy("shared.placeholder.short");
      const totalPercentRaw = grandTotal > 0 ? (entry.totalTokens / grandTotal) * 100 : 0;
      const totalPercent = Number.isFinite(totalPercentRaw) ? totalPercentRaw.toFixed(2) : "0.00";
      const models = entry.models
        .flatMap((model: any) => {
          const modelTokens = resolveDisplayTokens(model?.totals);
          if (!Number.isFinite(modelTokens) || modelTokens <= 0) return [];
          const share =
            entry.totalTokens > 0 ? Math.round((modelTokens / entry.totalTokens) * 1000) / 10 : 0;
          const name = resolveModelName(model, safeCopy("shared.placeholder.short"));
          const id = resolveModelId(model);
          const explicitModelCost = toFiniteNumber(model?.totals?.total_cost_usd);
          const modelCost =
            explicitModelCost != null
              ? explicitModelCost
              : entry.totalCost > 0 && entry.totalTokens > 0
                ? (modelTokens / entry.totalTokens) * entry.totalCost
                : null;
          return [{ id, name, share, usage: modelTokens, cost: modelCost }];
        });
      // Input-side cache hit rate = cache reads / all input-side tokens
      // (non-cached input + cache reads + cache writes). cached_input_tokens are
      // reads, cache_creation_input_tokens are writes. null when the source does
      // no caching at all (e.g. Gemini/Antigravity report neither) so the UI omits
      // the line instead of showing a meaningless 0%.
      const cacheInputTokens = entry.inputTokens + entry.cacheRead + entry.cacheCreate;
      const hasCacheActivity = entry.cacheRead + entry.cacheCreate > 0;
      const cacheHitRate =
        hasCacheActivity && cacheInputTokens > 0
          ? Math.round((entry.cacheRead / cacheInputTokens) * 100)
          : null;
      return {
        source: entry.source,
        label,
        totalPercent: String(totalPercent),
        totalPercentValue: totalPercentRaw,
        usd: entry.totalCost,
        usage: entry.totalTokens,
        cacheHitRate,
        cacheReusedTokens: entry.cacheRead,
        cacheInputTokens,
        models,
      };
    });
}

/**
 * Flatten the provider-oriented fleet data into one personal model ranking.
 * The same model name can be emitted by several tools, so names are matched
 * case-insensitively and their token/cost totals are combined before ranking.
 */
export function buildAllModels(fleetData: any) {
  const providers: any[] = Array.isArray(fleetData) ? fleetData : [];
  const byModel = new Map();
  const modelRows = [];

  for (const provider of providers) {
    const models: any[] = Array.isArray(provider?.models) ? provider.models : [];
    for (const model of models) {
      const usage = toFiniteNumber(model?.usage);
      if (usage == null || usage <= 0) continue;
      const name = typeof model?.name === "string" && model.name.trim()
        ? model.name.trim()
        : typeof model?.id === "string" && model.id.trim()
          ? model.id.trim()
          : null;
      if (!name) continue;
      modelRows.push({ model, name, usage });
    }
  }

  const bareNames = buildBareModelNameIndex(
    modelRows.map((row) => ({ name: row.name, weight: row.usage })),
  );

  for (const { model, name, usage } of modelRows) {
    const identity = resolveAggregateModelIdentity(name, bareNames);
    if (!identity) continue;
    const { key } = identity;
    const current = byModel.get(key) || {
      id: key,
      name: identity.name,
      usage: 0,
      cost: 0,
      hasCost: false,
      nameWeight: 0,
    };
    current.usage += usage;
    const cost = toFiniteNumber(model?.cost);
    if (cost != null) {
      current.cost += cost;
      current.hasCost = true;
    }
    // Preserve the spelling from the source that contributes the most.
    if (bareNames.has(key)) {
      current.name = bareNames.get(key);
    } else if (usage >= current.nameWeight) {
      current.name = name;
      current.nameWeight = usage;
    }
    byModel.set(key, current);
  }

  const totalUsage = Array.from(byModel.values())
    .reduce((sum, model) => sum + model.usage, 0);

  return Array.from(byModel.values())
    .map((model) => ({
      id: model.id,
      name: model.name,
      usage: model.usage,
      cost: model.hasCost ? model.cost : null,
      share: totalUsage > 0
        ? Math.round((model.usage / totalUsage) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => {
      if (b.usage !== a.usage) return b.usage - a.usage;
      return String(a.name).localeCompare(String(b.name));
    });
}

export function buildTopModels(modelBreakdown: any, { limit = 3, copyFn }: AnyRecord = {}) {
  const safeCopy = typeof copyFn === "function" ? copyFn : (key: string) => key;
  const sources: any[] = Array.isArray(modelBreakdown?.sources) ? modelBreakdown.sources : [];
  if (!sources.length) return [];

  const totalsByKey = new Map();
  const nameByKey = new Map();
  const nameWeight = new Map();
  const modelRows = [];
  let totalTokensAll = 0;

  for (const source of sources) {
    const models: any[] = Array.isArray(source?.models) ? source.models : [];
    for (const model of models) {
      const tokens = resolveDisplayTokens(model?.totals);
      if (!Number.isFinite(tokens) || tokens <= 0) continue;
      totalTokensAll += tokens;
      const name = resolveModelName(model, safeCopy("shared.placeholder.short"));
      modelRows.push({ name, tokens });
    }
  }

  const bareNames = buildBareModelNameIndex(
    modelRows.map((row) => ({ name: row.name, weight: row.tokens })),
  );
  for (const { name, tokens } of modelRows) {
      const identity = resolveAggregateModelIdentity(name, bareNames);
      if (!identity) continue;
      const { key } = identity;
      totalsByKey.set(key, (totalsByKey.get(key) || 0) + tokens);
      if (bareNames.has(key)) {
        nameByKey.set(key, bareNames.get(key));
      } else if (tokens >= (nameWeight.get(key) || 0)) {
        nameWeight.set(key, tokens);
        nameByKey.set(key, name);
      }
  }

  if (!totalsByKey.size) return [];

  const knownTotal = Array.from(totalsByKey.values()).reduce((acc, value) => acc + value, 0);
  const totalTokens = totalTokensAll > 0 ? totalTokensAll : knownTotal;

  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
  return Array.from(totalsByKey.entries())
    .map(([key, tokens]) => {
      const percent = totalTokens > 0 ? ((tokens / totalTokens) * 100).toFixed(1) : "0.0";
      return {
        id: key,
        name: nameByKey.get(key) || safeCopy("shared.placeholder.short"),
        tokens,
        percent: String(percent),
      };
    })
    .sort((a, b) => {
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      return String(a.name).localeCompare(String(b.name));
    })
    .slice(0, normalizedLimit);
}
