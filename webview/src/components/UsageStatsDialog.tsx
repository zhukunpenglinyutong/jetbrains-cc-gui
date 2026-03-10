import { useEffect, useMemo } from 'react';
import type { ClaudeMessage } from '../types';

interface UsageStatsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ClaudeMessage[];
}

/**
 * UsageStatsDialog - 展示会话的详细 token 使用统计
 */
const UsageStatsDialog = ({ isOpen, onClose, messages }: UsageStatsDialogProps) => {
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  // 计算整体统计
  const overallStats = useMemo(() => {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalInputCost = 0;
    let totalOutputCost = 0;
    let lastModel = '';
    let messageCount = 0;

    messages.forEach((message) => {
      if (message.type === 'assistant' && message.usage) {
        totalInput += message.usage.inputTokens || 0;
        totalOutput += message.usage.outputTokens || 0;
        totalCacheCreation += message.usage.cacheCreationTokens || 0;
        totalCacheRead += message.usage.cacheReadTokens || 0;
        totalInputCost += message.usage.inputCost || 0;
        totalOutputCost += message.usage.outputCost || 0;
        if (message.usage.model) {
          lastModel = message.usage.model;
        }
        messageCount++;
      }
    });

    const totalTokens = totalInput + totalOutput + totalCacheCreation + totalCacheRead;

    return {
      input: totalInput,
      output: totalOutput,
      cacheCreation: totalCacheCreation,
      cacheRead: totalCacheRead,
      total: totalTokens,
      inputCost: totalInputCost,
      outputCost: totalOutputCost,
      totalCost: totalInputCost + totalOutputCost,
      model: lastModel,
      messageCount,
    };
  }, [messages]);

  // 获取每条消息的使用情况
  const messageStats = useMemo(() => {
    return messages
      .map((message, index) => {
        if (message.type === 'assistant' && message.usage) {
          const inputTokens = message.usage.inputTokens || 0;
          const outputTokens = message.usage.outputTokens || 0;
          const cacheCreationTokens = message.usage.cacheCreationTokens || 0;
          const cacheReadTokens = message.usage.cacheReadTokens || 0;
          const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

          return {
            index: index + 1,
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
            totalTokens,
            inputCost: message.usage.inputCost || 0,
            outputCost: message.usage.outputCost || 0,
            totalCost: (message.usage.inputCost || 0) + (message.usage.outputCost || 0),
            model: message.usage.model || '',
            timestamp: message.timestamp,
          };
        }
        return null;
      })
      .filter((stat) => stat !== null)
      .reverse(); // 最新的消息在前
  }, [messages]);

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

  // 格式化数字
  const formatNumber = (num: number): string => {
    return num.toLocaleString();
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="confirm-dialog-overlay" onClick={onClose}>
      <div
        className="usage-stats-dialog confirm-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '700px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* 标题栏 */}
        <div className="confirm-dialog-header">
          <h3 className="confirm-dialog-title">Token 使用统计</h3>
          <button className="close-button" onClick={onClose} aria-label="关闭">
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        {/* 主体内容 */}
        <div className="confirm-dialog-body" style={{ overflowY: 'auto', flex: 1 }}>
          {/* 总体统计 */}
          <div className="usage-stats-summary">
            <h4 style={{ marginTop: 0 }}>会话总计</h4>
            <div className="stats-grid">
              <div className="stat-item">
                <span className="stat-label">模型:</span>
                <span className="stat-value">{formatModelName(overallStats.model)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">回复次数:</span>
                <span className="stat-value">{overallStats.messageCount}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">输入 Tokens:</span>
                <span className="stat-value">{formatNumber(overallStats.input)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">输出 Tokens:</span>
                <span className="stat-value">{formatNumber(overallStats.output)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">缓存写入 Tokens:</span>
                <span className="stat-value">{formatNumber(overallStats.cacheCreation)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">缓存读取 Tokens:</span>
                <span className="stat-value">{formatNumber(overallStats.cacheRead)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">总计 Tokens:</span>
                <span className="stat-value stat-highlight">{formatNumber(overallStats.total)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">输入成本:</span>
                <span className="stat-value">${overallStats.inputCost.toFixed(4)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">输出成本:</span>
                <span className="stat-value">${overallStats.outputCost.toFixed(4)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">总成本:</span>
                <span className="stat-value stat-highlight">${overallStats.totalCost.toFixed(4)}</span>
              </div>
            </div>
          </div>

          {/* 每条消息的详细统计 */}
          {messageStats.length > 0 && (
            <div className="usage-stats-details">
              <h4>消息详情</h4>
              <div className="message-stats-list">
                {messageStats.map((stat, idx) => (
                  <div key={idx} className="message-stat-item">
                    <div className="message-stat-header">
                      <span className="message-index">消息 #{messages.length - stat.index + 1}</span>
                      <span className="message-model">{formatModelName(stat.model)}</span>
                    </div>
                    <div className="message-stat-content">
                      <div className="message-stat-row">
                        <span>输入: {formatNumber(stat.inputTokens)}</span>
                        <span>输出: {formatNumber(stat.outputTokens)}</span>
                      </div>
                      {(stat.cacheCreationTokens > 0 || stat.cacheReadTokens > 0) && (
                        <div className="message-stat-row">
                          <span>缓存写入: {formatNumber(stat.cacheCreationTokens)}</span>
                          <span>缓存读取: {formatNumber(stat.cacheReadTokens)}</span>
                        </div>
                      )}
                      <div className="message-stat-row">
                        <span className="stat-total">总计: {formatNumber(stat.totalTokens)}</span>
                        <span>成本: ${stat.totalCost.toFixed(4)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-button confirm-button" onClick={onClose} autoFocus>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};

export default UsageStatsDialog;
