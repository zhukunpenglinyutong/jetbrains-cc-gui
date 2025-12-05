/**
 * 模型工具模块
 * 负责模型 ID 映射
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

// 注意：getClaudeCliPath() 函数已被移除
// 现在完全使用 SDK 内置的 cli.js（位于 node_modules/@anthropic-ai/claude-agent-sdk/cli.js）
// 这样可以避免 Windows 下系统 CLI 路径问题（ENOENT 错误），且版本与 SDK 完全对齐
