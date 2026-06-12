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
 * Get the color level class based on percentage.
 */
const getLevelClass = (percentage: number): string => {
  if (percentage >= 80) return 'level-high';
  if (percentage >= 50) return 'level-warn';
  return 'level-ok';
};

/**
 * 格式化 token 数量为人类可读格式
 */
const formatNumber = (num: number) => num.toLocaleString('en-US');

/**
 * 格式化 maxTokens 为 K 显示
 */
const formatMaxTokensK = (maxTokens?: number): string => {
  if (!maxTokens) return '';
  if (maxTokens >= 1_000_000) return `${maxTokens / 1_000_000}M`;
  if (maxTokens >= 1_000) return `${maxTokens / 1_000}K`;
  return `${maxTokens}`;
};

/**
 * TokenIndicator - Chip 样式触发器 + 悬浮详情弹窗
 *
 * 鼠标悬浮到 chip 上显示完整弹窗:
 *   header (icon + title + subtitle) → 2×2 metric grid → usage bar → source row
 */
export const TokenIndicator = ({
  percentage,
  usedTokens,
  maxTokens,
  tokenDetail,
  modelName,
}: TokenIndicatorProps) => {
  const { t } = useTranslation();

  const labelPct = `${Math.round(percentage)}`;
  const levelClass = getLevelClass(percentage);

  const formatTokens = (value?: number) => {
    if (typeof value !== 'number' || !isFinite(value)) return undefined;
    if (value >= 1_000) {
      const kValue = value / 1_000;
      return Number.isInteger(kValue) ? `${kValue}k` : `${kValue.toFixed(1)}k`;
    }
    return `${value}`;
  };

  const usedText = formatTokens(usedTokens);
  const maxText = formatTokens(maxTokens);
  const tooltipPct = `${(Math.round(percentage * 10) / 10).toFixed(1)}%`;

  // mini-ring 的 conic-gradient 角度
  const conicAngle = Math.max(0, Math.min(100, percentage));
  // 根据等级选择 mini-ring 颜色
  const ringColor =
    levelClass === 'level-high' ? '#d9534f' :
    levelClass === 'level-warn' ? '#e7b85a' :
    '#4cc38a';

  const renderDetailedTooltip = () => {
    if (!tokenDetail) {
      // 无 tokenDetail 时显示简单提示
      const simpleText = usedText && maxText
        ? `${tooltipPct} · ${usedText} / ${maxText} ${t('chat.context')}`
        : t('chat.usagePercentage', { percentage: tooltipPct });
      return (
        <div className="token-detail-tooltip">
          <div className="token-detail-body" style={{ padding: '10px 14px' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{simpleText}</span>
          </div>
        </div>
      );
    }

    return (
      <div className="token-detail-tooltip">
        {/* Header: icon + title + subtitle */}
        <div className="token-detail-header">
          <div className="token-detail-header-icon">
            <TokenIcon name="dashboard" size={16} />
          </div>
          <div>
            <div className="token-detail-title">{t('chat.tokenIndicator.contextStats')}</div>
            <div className="token-detail-subtitle">
              {t('chat.tokenIndicator.sessionInfo', {
                model: modelName || 'Unknown',
                maxTokens: formatMaxTokensK(tokenDetail.maxTokens || maxTokens),
              })}
            </div>
            <div className="token-detail-subtitle token-detail-includes">
              {t('chat.tokenIndicator.includes')}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="token-detail-body">
          {/* 2×2 metric grid */}
          <div className="token-detail-grid">
            <div className="token-detail-metric input">
              <div className="token-detail-metric-label">
                <TokenIcon name="arrow-down" />
                <span>{t('chat.tokenIndicator.inputToken')}</span>
              </div>
              <div className="token-detail-metric-value">{formatNumber(tokenDetail.inputTokens)}</div>
            </div>
            <div className="token-detail-metric output">
              <div className="token-detail-metric-label">
                <TokenIcon name="arrow-up" />
                <span>{t('chat.tokenIndicator.outputToken')}</span>
              </div>
              <div className="token-detail-metric-value">{formatNumber(tokenDetail.outputTokens)}</div>
            </div>
            <div className="token-detail-metric cache-read">
              <div className="token-detail-metric-label">
                <TokenIcon name="database" />
                <span>{t('chat.tokenIndicator.cacheRead')}</span>
              </div>
              <div className="token-detail-metric-value">
                {formatNumber(tokenDetail.cacheReadTokens)}
                <span className="token-detail-metric-sub">
                  {t('chat.tokenIndicator.cacheHitRate', { rate: tokenDetail.cacheHitRate.toFixed(1) })}
                </span>
              </div>
            </div>
            <div className="token-detail-metric cache-write">
              <div className="token-detail-metric-label">
                <TokenIcon name="archive" />
                <span>{t('chat.tokenIndicator.cacheWrite')}</span>
              </div>
              <div className="token-detail-metric-value">{formatNumber(tokenDetail.cacheCreationTokens)}</div>
            </div>
          </div>

          {/* Usage total + progress bar */}
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

          {/* Source row */}
          <div className="token-detail-source">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <span>{t('chat.tokenIndicator.source')}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className={`ring-indicator ${levelClass}`}
      role="meter"
      tabIndex={0}
      aria-label={`${t('chat.tokenIndicator.contextStats')} ${labelPct}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.max(0, Math.min(100, Math.round(percentage)))}
    >
      {/* Conic-gradient ring */}
      <span
        className="ring"
        style={{
          background: `conic-gradient(${ringColor} 0 ${conicAngle}%, var(--ring-track) ${conicAngle}% 100%)`,
        }}
      />
      {/* Centered percentage text */}
      <span className="ring-pct">{labelPct}%</span>
      {/* Hover detail card */}
      <div className="ring-tooltip">
        {renderDetailedTooltip()}
      </div>
    </div>
  );
};

export default TokenIndicator;
