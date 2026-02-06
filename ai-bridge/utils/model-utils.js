/**
 * 模型工具模块
 * 负责模型 ID 映射和环境变量设置
 */

/**
 * 将完整的模型 ID 映射为 Claude SDK 期望的简短名称
 * @param {string} modelId - 完整的模型 ID（如 'claude-sonnet-4-5'）
 * @returns {string} SDK 期望的模型名称（如 'sonnet'）
 */
export function mapModelIdToSdkName(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return 'sonnet'; // 默认使用 sonnet
  }

  const lowerModel = modelId.toLowerCase();

  // 映射规则：
  // - 包含 'opus' -> 'opus'
  // - 包含 'haiku' -> 'haiku'
  // - 其他情况（包含 'sonnet' 或未知）-> 'sonnet'
  if (lowerModel.includes('opus')) {
    return 'opus';
  } else if (lowerModel.includes('haiku')) {
    return 'haiku';
  } else {
    return 'sonnet';
  }
}

/**
 * 根据完整模型 ID 设置 SDK 环境变量
 * Claude SDK 使用短名称（opus/sonnet/haiku）作为模型选择器，
 * 具体版本由 ANTHROPIC_DEFAULT_*_MODEL 环境变量指定
 *
 * @param {string} modelId - 完整的模型 ID（如 'claude-opus-4-6'）
 */
export function setModelEnvironmentVariables(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return;
  }

  const lowerModel = modelId.toLowerCase();

  // 根据模型类型设置对应的环境变量
  // 这样 SDK 就能知道具体使用哪个版本
  if (lowerModel.includes('opus')) {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_OPUS_MODEL =', modelId);
  } else if (lowerModel.includes('haiku')) {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_HAIKU_MODEL =', modelId);
  } else if (lowerModel.includes('sonnet')) {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_SONNET_MODEL =', modelId);
  }
}

// 注意：getClaudeCliPath() 函数已被移除
// 现在完全使用 SDK 内置的 cli.js（位于 node_modules/@anthropic-ai/claude-agent-sdk/cli.js）
// 这样可以避免 Windows 下系统 CLI 路径问题（ENOENT 错误），且版本与 SDK 完全对齐
