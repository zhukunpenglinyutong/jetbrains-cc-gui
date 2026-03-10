import { useMemo, useState } from 'react';
import type { ClaudeMessage } from '../../types';
import UsageStatsDialog from '../UsageStatsDialog';

export interface SessionTokenStatsProps {
  messages: ClaudeMessage[];
}

/**
 * SessionTokenStats - 显示当前会话的累计 token 统计和成本
 * 显示在输入框右下角，发送按钮左边
 */
export const SessionTokenStats = ({ messages }: SessionTokenStatsProps) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // 计算会话累计 token 统计和成本
  const sessionStats = useMemo(() => {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalInputCost = 0;
    let totalOutputCost = 0;
    let lastModel = '';
    let hasCostData = false; // 标记是否有成本数据

    messages.forEach((message) => {
      if (message.type === 'assistant' && message.usage) {
        totalInput += message.usage.inputTokens || 0;
        totalOutput += message.usage.outputTokens || 0;
        totalCacheCreation += message.usage.cacheCreationTokens || 0;
        totalCacheRead += message.usage.cacheReadTokens || 0;

        // 只有当 message.usage 包含成本字段时才累加
        if (typeof message.usage.inputCost === 'number' && typeof message.usage.outputCost === 'number') {
          totalInputCost += message.usage.inputCost;
          totalOutputCost += message.usage.outputCost;
          hasCostData = true;
        }

        if (message.usage.model) {
          lastModel = message.usage.model;
        }
      }
    });

    // 计算总 token 数（包含所有类型）
    const totalTokens = totalInput + totalOutput + totalCacheCreation + totalCacheRead;

    return {
      input: totalInput,
      output: totalOutput,
      cacheCreation: totalCacheCreation,
      cacheRead: totalCacheRead,
      totalTokens,
      inputCost: totalInputCost,
      outputCost: totalOutputCost,
      totalCost: totalInputCost + totalOutputCost,
      model: lastModel,
      hasCostData, // 是否有准确的成本数据
    };
  }, [messages]);

  // 格式化数字（使用 k 表示千）
  const formatNumber = (num: number): string => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}k`;
    }
    return num.toString();
  };

  // 缩短模型名称
  const formatModelName = (model: string): string => {
    if (!model) return '';
    // 移除不必要的前缀和后缀，保留核心模型名称
    // 例如: global.anthropic.claude-sonnet-4-5-20250929-v1:0 → sonnet-4.5
    // 例如: claude-sonnet-4-6 → sonnet-4.6
    return model
      .replace(/^.*\.anthropic\./, '') // 移除 global.anthropic. 等前缀
      .replace(/^claude-/, '') // 移除 claude- 前缀
      .replace(/-\d{8}.*$/, '') // 移除日期和后续所有内容（包括 -v1:0）
      .replace(/(\w+)-(\d+)-(\d+)$/, '$1-$2.$3'); // 将版本号的 - 替换为 .
  };

  // 如果没有任何 token 使用，不显示
  if (sessionStats.totalTokens === 0) {
    return null;
  }

  return (
    <>
      <div
        className="session-token-stats"
        onClick={() => setIsDialogOpen(true)}
        style={{ cursor: 'pointer' }}
        title="点击查看详细使用统计"
      >
      {/* 模型名称 */}
      {sessionStats.model && (
        <span className="session-token-model" title={sessionStats.model}>
          {formatModelName(sessionStats.model)}
        </span>
      )}
      {/* 总 token 数 */}
      <span
        className="session-token-item"
        title={`总计: ${sessionStats.totalTokens.toLocaleString()} tokens\n输入: ${sessionStats.input.toLocaleString()}\n输出: ${sessionStats.output.toLocaleString()}\n缓存写入: ${sessionStats.cacheCreation.toLocaleString()}\n缓存读取: ${sessionStats.cacheRead.toLocaleString()}`}
      >
        {formatNumber(sessionStats.totalTokens)}
      </span>
      {/* 只有在有准确成本数据时才显示总成本 */}
      {sessionStats.hasCostData && (
        <>
          <span className="session-token-separator">|</span>
          {/* 总成本（包含输入、输出、缓存写入、缓存读取） */}
          <span className="session-token-cost" title={`总成本: $${sessionStats.totalCost.toFixed(4)}\n输入成本: $${sessionStats.inputCost.toFixed(4)}\n输出成本: $${sessionStats.outputCost.toFixed(4)}`}>
            ${sessionStats.totalCost.toFixed(4)}
          </span>
        </>
      )}
      </div>

      <UsageStatsDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        messages={messages}
      />
    </>
  );
};

export default SessionTokenStats;
