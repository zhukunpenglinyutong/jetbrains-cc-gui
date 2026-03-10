/**
 * Shared usage accumulation utilities for streaming token tracking.
 * Used by message-service.js and persistent-query-service.js.
 */

export const DEFAULT_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
};

/**
 * 模型价格表 (每百万 tokens 的价格，单位：美元)
 * 价格来源：Claude API 官方定价 (2025年1月)
 */
const MODEL_PRICING = {
  // Claude 4.6 系列
  'claude-opus-4-6': {
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.50
  },
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.30
  },
  // Claude 4.5 系列
  'claude-sonnet-4-5': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.30
  },
  'claude-haiku-4-5': {
    input: 0.8,
    output: 4.0,
    cacheWrite: 1.0,
    cacheRead: 0.08
  },
  // Claude 4 系列（向后兼容）
  'claude-opus-4': {
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.50
  },
  'claude-sonnet-4': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.30
  },
  'claude-haiku-4': {
    input: 0.8,
    output: 4.0,
    cacheWrite: 1.0,
    cacheRead: 0.08
  }
};

/**
 * 根据模型名称获取价格表
 * 支持完整模型名称匹配，包括版本号（如 4.5, 4.6）
 * @returns {Object|null} 价格对象，如果模型未知则返回 null
 */
function getModelPricing(model) {
  if (!model) return null;

  const modelLower = model.toLowerCase();

  // 优先匹配具体版本号（4.6, 4.5）
  if (modelLower.includes('opus-4-6') || modelLower.includes('opus-4.6')) {
    return MODEL_PRICING['claude-opus-4-6'];
  }
  if (modelLower.includes('sonnet-4-6') || modelLower.includes('sonnet-4.6')) {
    return MODEL_PRICING['claude-sonnet-4-6'];
  }
  if (modelLower.includes('sonnet-4-5') || modelLower.includes('sonnet-4.5')) {
    return MODEL_PRICING['claude-sonnet-4-5'];
  }
  if (modelLower.includes('haiku-4-5') || modelLower.includes('haiku-4.5')) {
    return MODEL_PRICING['claude-haiku-4-5'];
  }

  // 回退到通用版本匹配
  if (modelLower.includes('opus-4') || modelLower.includes('opus_4')) {
    return MODEL_PRICING['claude-opus-4'];
  }
  if (modelLower.includes('haiku-4') || modelLower.includes('haiku_4')) {
    return MODEL_PRICING['claude-haiku-4'];
  }
  if (modelLower.includes('sonnet-4') || modelLower.includes('sonnet_4')) {
    return MODEL_PRICING['claude-sonnet-4'];
  }

  // 未知模型，返回 null 表示无法计算准确成本
  return null;
}

/**
 * 计算 token 使用的成本
 * @param {Object} usage - token 使用数据
 * @param {string} model - 模型名称
 * @returns {Object|null} 包含输入成本和输出成本的对象，如果模型未知则返回 null
 */
function calculateCost(usage, model) {
  const pricing = getModelPricing(model);

  // 如果无法获取模型价格，返回 null 表示无法计算成本
  if (!pricing) {
    return null;
  }

  // 计算输入成本（包括缓存写入）
  const inputCost = ((usage.input_tokens || 0) * pricing.input +
    (usage.cache_creation_input_tokens || 0) * pricing.cacheWrite +
    (usage.cache_read_input_tokens || 0) * pricing.cacheRead) / 1_000_000.0;

  // 计算输出成本
  const outputCost = ((usage.output_tokens || 0) * pricing.output) / 1_000_000.0;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
}

/**
 * Merge usage data following CLI's nz6() logic.
 * - input_tokens, cache_*: only update if new value > 0 (preserve accumulated)
 * - output_tokens: use new value directly (incremental updates)
 */
export function mergeUsage(accumulated, newUsage) {
  if (!newUsage) return accumulated || { ...DEFAULT_USAGE };
  if (!accumulated) return { ...DEFAULT_USAGE, ...newUsage };
  return {
    input_tokens: newUsage.input_tokens > 0 ? newUsage.input_tokens : accumulated.input_tokens,
    cache_creation_input_tokens: newUsage.cache_creation_input_tokens > 0
      ? newUsage.cache_creation_input_tokens : accumulated.cache_creation_input_tokens,
    cache_read_input_tokens: newUsage.cache_read_input_tokens > 0
      ? newUsage.cache_read_input_tokens : accumulated.cache_read_input_tokens,
    output_tokens: newUsage.output_tokens ?? accumulated.output_tokens
  };
}

/**
 * Emit [USAGE] tag from accumulated usage data during streaming.
 * NOTE: Uses process.stdout.write for consistent buffering with other IPC messages.
 * @param {Object} accumulated - 累积的 usage 数据
 * @param {string} model - 模型名称
 */
export function emitAccumulatedUsage(accumulated, model = null) {
  if (!accumulated) return;

  const cost = calculateCost(accumulated, model);

  // 构建 usage 对象
  const usageData = {
    input_tokens: accumulated.input_tokens || 0,
    output_tokens: accumulated.output_tokens || 0,
    cache_creation_input_tokens: accumulated.cache_creation_input_tokens || 0,
    cache_read_input_tokens: accumulated.cache_read_input_tokens || 0,
    model: model || ''
  };

  // 只有成功计算出成本时才添加成本字段
  if (cost !== null) {
    usageData.input_cost = cost.inputCost;
    usageData.output_cost = cost.outputCost;
    usageData.total_cost = cost.totalCost;
  }

  process.stdout.write('[USAGE] ' + JSON.stringify(usageData) + '\n');
}
