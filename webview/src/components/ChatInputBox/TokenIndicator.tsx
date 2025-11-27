import type { TokenIndicatorProps } from './types';

/**
 * TokenIndicator - 使用量圆环进度条组件
 * 使用 SVG 双圆圈方案实现
 */
export const TokenIndicator = ({
  percentage,
  size = 14,
  usedTokens,
  maxTokens,
}: TokenIndicatorProps) => {
  // 圆的半径（留出 stroke 空间）
  const radius = (size - 3) / 2;
  const center = size / 2;

  // 圆周长
  const circumference = 2 * Math.PI * radius;

  // 计算偏移量（从顶部开始顺时针填充）
  const strokeOffset = circumference * (1 - percentage / 100);

  // 百分比统一保留一位小数（四舍五入），但 .0 结尾时隐藏小数
  const rounded = Math.round(percentage * 10) / 10;
  const formattedPercentage = Number.isInteger(rounded)
    ? `${Math.round(rounded)}%`
    : `${rounded.toFixed(1)}%`;

  const formatTokens = (value?: number) => {
    if (typeof value !== 'number' || !isFinite(value)) return undefined;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return `${value}`;
  };

  const usedText = formatTokens(usedTokens);
  const maxText = formatTokens(maxTokens);
  const tooltip = usedText && maxText
    ? `${formattedPercentage} · ${usedText} / ${maxText} 上下文`
    : `使用量: ${formattedPercentage}`;

  return (
    <div className="token-indicator">
      <div className="token-indicator-wrap">
        <svg
          className="token-indicator-ring"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
        >
          {/* 背景圆 */}
          <circle
            className="token-indicator-bg"
            cx={center}
            cy={center}
            r={radius}
          />
          {/* 进度弧 */}
          <circle
            className="token-indicator-fill"
            cx={center}
            cy={center}
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
          />
        </svg>
        {/* 悬停气泡 */}
        <div className="token-tooltip">
          {tooltip}
        </div>
      </div>
      <span className="token-percentage-label">{formattedPercentage}</span>
    </div>
  );
};

export default TokenIndicator;
