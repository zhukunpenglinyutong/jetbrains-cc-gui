import { useTranslation } from 'react-i18next';
import type { TokenIndicatorProps } from './types';


/**
 * TokenIndicator - Usage ring progress bar component
 * Implemented using SVG dual-circle approach
 */
export const TokenIndicator = ({
  percentage,
  size = 14,
  usedTokens,
  maxTokens,
  tokenDetail,
}: TokenIndicatorProps) => {
  const { t } = useTranslation();
  // Circle radius (accounting for stroke space)
  const radius = (size - 3) / 2;
  const center = size / 2;

  // Circumference
  const circumference = 2 * Math.PI * radius;

  // Calculate offset (fill clockwise from top)
  const strokeOffset = circumference * (1 - percentage / 100);

  // Indicator label: integer percentage (no decimal)
  const labelPercentage = `${Math.round(percentage)}%`;
  // Tooltip: one decimal place for precision
  const tooltipPercentage = `${(Math.round(percentage * 10) / 10).toFixed(1)}%`;

  const formatTokens = (value?: number) => {
    if (typeof value !== 'number' || !isFinite(value)) return undefined;
    // Always display capacity in k (thousands) units
    // e.g.: 1,000,000 -> 1000k, 500,000 -> 500k
    if (value >= 1_000) {
      const kValue = value / 1_000;
      // If it's a whole number, don't show decimal point
      return Number.isInteger(kValue) ? `${kValue}k` : `${kValue.toFixed(1)}k`;
    }
    return `${value}`;
  };

  const usedText = formatTokens(usedTokens);
  const maxText = formatTokens(maxTokens);
  const simpleTooltip = usedText && maxText
    ? `${tooltipPercentage} · ${usedText} / ${maxText} ${' '}${t('chat.context')}`
    : t('chat.usagePercentage', { percentage: tooltipPercentage });

  // Render detailed tooltip if tokenDetail is available
  const renderDetailedTooltip = () => {
    if (!tokenDetail) return simpleTooltip;

    const formatNumber = (num: number) => {
      return num.toLocaleString('en-US');
    };

    return (
      <div className="token-detail-tooltip">
        <div className="token-detail-header">📊 Token 使用详情</div>
        <div className="token-detail-row">
          <span className="token-detail-label">输入 Token:</span>
          <span className="token-detail-value">{formatNumber(tokenDetail.inputTokens)}</span>
        </div>
        <div className="token-detail-row">
          <span className="token-detail-label">输出 Token:</span>
          <span className="token-detail-value">{formatNumber(tokenDetail.outputTokens)}</span>
        </div>
        <div className="token-detail-row">
          <span className="token-detail-label">缓存创建:</span>
          <span className="token-detail-value">{formatNumber(tokenDetail.cacheCreationTokens)}</span>
        </div>
        <div className="token-detail-row">
          <span className="token-detail-label">缓存读取:</span>
          <span className="token-detail-value">{formatNumber(tokenDetail.cacheReadTokens)}</span>
        </div>
        <div className="token-detail-row token-detail-total">
          <span className="token-detail-label">总计:</span>
          <span className="token-detail-value">{formatNumber(tokenDetail.totalTokens)} / {formatNumber(tokenDetail.maxTokens)}</span>
        </div>
        <div className="token-detail-row">
          <span className="token-detail-label">使用率:</span>
          <span className="token-detail-value">{tokenDetail.percentage.toFixed(1)}%</span>
        </div>
        <div className="token-detail-row">
          <span className="token-detail-label">缓存命中率:</span>
          <span className="token-detail-value">{tokenDetail.cacheHitRate.toFixed(1)}%</span>
        </div>
      </div>
    );
  };

  return (
    <div className="token-indicator">
      <div className="token-indicator-wrap">
        <svg
          className="token-indicator-ring"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
        >
          {/* Background circle */}
          <circle
            className="token-indicator-bg"
            cx={center}
            cy={center}
            r={radius}
          />
          {/* Progress arc */}
          <circle
            className="token-indicator-fill"
            cx={center}
            cy={center}
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
          />
        </svg>
        {/* Hover tooltip */}
        <div className="token-tooltip">
          {renderDetailedTooltip()}
        </div>
      </div>
      <span className="token-percentage-label">{labelPercentage}</span>
    </div>
  );
};

export default TokenIndicator;
