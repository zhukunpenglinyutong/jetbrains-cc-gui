import { useTranslation } from 'react-i18next';
import type { TokenIndicatorProps } from './types';
import { ArrowDownIcon, ArrowUpIcon, DatabaseIcon, LayersIcon } from '../Icons';

// SVG Icon component for token detail metrics
const TokenIcon = ({ name, size = 14 }: { name: string; size?: number }) => {
  switch (name) {
    case 'arrow-down':
      return <ArrowDownIcon size={size} className="token-detail-icon" />;
    case 'arrow-up':
      return <ArrowUpIcon size={size} className="token-detail-icon" />;
    case 'database':
      return <DatabaseIcon size={size} className="token-detail-icon" />;
    case 'archive':
      return <LayersIcon size={size} className="token-detail-icon" />;
    case 'dashboard':
      return <LayersIcon size={size} className="token-detail-icon" />;
    default:
      return <LayersIcon size={size} className="token-detail-icon" />;
  }
};

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

  const formatNumber = (num: number) => {
    return num.toLocaleString('en-US');
  };

  const renderMetric = (
    className: string,
    icon: string,
    label: string,
    value: number,
    subText?: string,
  ) => (
    <div className={`token-detail-metric ${className}`}>
      <div className="token-detail-metric-label">
        <TokenIcon name={icon} />
        <span>{label}</span>
      </div>
      <div className="token-detail-metric-value">
        {formatNumber(value)}
        {subText ? <span className="token-detail-metric-sub">{subText}</span> : null}
      </div>
    </div>
  );

  // Render detailed tooltip if tokenDetail is available
  const renderDetailedTooltip = () => {
    if (!tokenDetail) {
      return <div className="token-detail-simple">{simpleTooltip}</div>;
    }

    return (
      <div className="token-detail-tooltip">
        <div className="token-detail-header">
          <div className="token-detail-header-icon">
            <TokenIcon name="dashboard" size={16} />
          </div>
          <div>
            <div className="token-detail-title">{t('chat.tokenIndicator.contextStats')}</div>
            <div className="token-detail-subtitle">{tooltipPercentage} · {usedText ?? formatNumber(tokenDetail.totalTokens)} / {maxText ?? formatNumber(tokenDetail.maxTokens)} {t('chat.context')}</div>
          </div>
        </div>
        <div className="token-detail-grid">
          {renderMetric('input', 'arrow-down', t('chat.tokenIndicator.inputToken'), tokenDetail.inputTokens)}
          {renderMetric('output', 'arrow-up', t('chat.tokenIndicator.outputToken'), tokenDetail.outputTokens)}
          {renderMetric('cache-read', 'database', t('chat.tokenIndicator.cacheRead'), tokenDetail.cacheReadTokens, t('chat.tokenIndicator.cacheHitRate', { rate: tokenDetail.cacheHitRate.toFixed(1) }))}
          {renderMetric('cache-write', 'archive', t('chat.tokenIndicator.cacheWrite'), tokenDetail.cacheCreationTokens)}
        </div>
        <div className="token-detail-total">
          <div className="token-detail-total-top">
            <span>{t('chat.tokenIndicator.total', { used: formatNumber(tokenDetail.totalTokens), max: formatNumber(tokenDetail.maxTokens) })}</span>
            <span>{tokenDetail.percentage.toFixed(1)}%</span>
          </div>
          <div className="token-detail-progress">
            <div
              className="token-detail-progress-fill"
              style={{ width: `${Math.max(0, Math.min(100, tokenDetail.percentage))}%` }}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className="token-indicator"
      role="meter"
      tabIndex={0}
      aria-label={`${t('chat.tokenIndicator.contextStats')} ${labelPercentage}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.max(0, Math.min(100, Math.round(percentage)))}
    >
      <div className="token-indicator-wrap" aria-hidden="true">
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
      </div>
      <span className="token-percentage-label">{labelPercentage}</span>
      <div className="token-tooltip">
        {renderDetailedTooltip()}
      </div>
    </div>
  );
};

export default TokenIndicator;
