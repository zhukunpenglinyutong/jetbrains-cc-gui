import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeMessage } from '../../types';

export interface SessionTokenStatsProps {
  messages: ClaudeMessage[];
}

/**
 * SessionTokenStats - 显示当前会话的累计 token 统计
 * 显示在输入框右下角，发送按钮左边
 */
export const SessionTokenStats = ({ messages }: SessionTokenStatsProps) => {
  const { t } = useTranslation();

  // 计算会话累计 token 统计
  const sessionStats = useMemo(() => {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;

    messages.forEach((message) => {
      if (message.type === 'assistant' && message.usage) {
        totalInput += message.usage.inputTokens || 0;
        totalOutput += message.usage.outputTokens || 0;
        totalCacheCreation += message.usage.cacheCreationTokens || 0;
        totalCacheRead += message.usage.cacheReadTokens || 0;
      }
    });

    const total = totalInput + totalOutput + totalCacheCreation + totalCacheRead;

    return {
      input: totalInput,
      output: totalOutput,
      cacheCreation: totalCacheCreation,
      cacheRead: totalCacheRead,
      total,
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

  // 如果没有任何 token 使用，不显示
  if (sessionStats.total === 0) {
    return null;
  }

  // 构建详细的 tooltip
  const tooltipLines = [
    t('chat.sessionTokenStats.title'),
    `↑ ${t('chat.sessionTokenStats.input')}: ${sessionStats.input.toLocaleString()}`,
    `↓ ${t('chat.sessionTokenStats.output')}: ${sessionStats.output.toLocaleString()}`,
  ];

  if (sessionStats.cacheCreation > 0) {
    tooltipLines.push(`⚡ ${t('chat.sessionTokenStats.cacheCreation')}: ${sessionStats.cacheCreation.toLocaleString()}`);
  }

  if (sessionStats.cacheRead > 0) {
    tooltipLines.push(`📖 ${t('chat.sessionTokenStats.cacheRead')}: ${sessionStats.cacheRead.toLocaleString()}`);
  }

  tooltipLines.push(`∑ ${t('chat.sessionTokenStats.total')}: ${sessionStats.total.toLocaleString()}`);

  const tooltipText = tooltipLines.join('\n');

  return (
    <div className="session-token-stats" title={tooltipText}>
      <span className="session-token-icon codicon codicon-pulse" />
      <span className="session-token-total">{formatNumber(sessionStats.total)}</span>
    </div>
  );
};

export default SessionTokenStats;
