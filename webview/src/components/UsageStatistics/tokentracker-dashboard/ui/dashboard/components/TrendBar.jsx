import React from "react";
import { m, useReducedMotion } from "motion/react";
import { cn } from "../../../lib/cn";
import { TOKEN_COLORS, getModelColor } from "./trendColors";

function getBarSegments(row) {
  if (!row) return [];
  const segments = [];

  // 1. 如果有 models，且 models 相加大于 0，则按模型拆分
  if (row.models && typeof row.models === "object") {
    for (const [modelName, val] of Object.entries(row.models)) {
      const numVal = Number(val);
      if (Number.isFinite(numVal) && numVal > 0) {
        segments.push({
          type: "model",
          name: modelName,
          value: numVal,
        });
      }
    }
  }

  // 2. 如果没有 models，或者 models 分量之和为 0，我们尝试按 Token 类型拆分
  if (segments.length === 0) {
    const tokenTypes = [
      { name: "Input", key: "input_tokens" },
      { name: "Cached Input", key: "cached_input_tokens" },
      { name: "Output", key: "output_tokens" },
      { name: "Reasoning Output", key: "reasoning_output_tokens" },
    ];
    for (const type of tokenTypes) {
      const val = Number(row[type.key]);
      if (Number.isFinite(val) && val > 0) {
        segments.push({
          type: "token_type",
          name: type.name,
          value: val,
        });
      }
    }
  }

  // 按用量降序排列，以使得较大的段沉入底部渲染，小分量在上。
  return segments.sort((a, b) => b.value - a.value);
}

// Bar kinds:
//   - "real":      row carries a positive observed value; render stacked segments.
//   - "real_zero": row is observed but value is 0 (truly idle period); render a flat baseline.
//   - "predicted": row is `future`; render interpolated/extrapolated height as a faint preview.
//   - "unsynced":  row is `missing`; render interpolated/extrapolated height as a faint preview.
function getBarKind(row, value) {
  if (row?.future) return "predicted";
  if (row?.missing) return "unsynced";
  if (value > 0) return "real";
  return "real_zero";
}

const PREVIEW_OPACITY = 0.35;
const BASELINE_HEIGHT_PX = 2;
const PREVIEW_MIN_HEIGHT_PX = 4;

function getBarHeight(kind, heightPercent, isPreview) {
  if (kind === "real") {
    return {
      barHeight: `${Math.max(heightPercent, 2)}%`,
      minHeight: `${PREVIEW_MIN_HEIGHT_PX}px`,
    };
  }
  if (isPreview && heightPercent > 0) {
    return {
      barHeight: `${heightPercent}%`,
      minHeight: `${PREVIEW_MIN_HEIGHT_PX}px`,
    };
  }
  // real_zero, or preview with no neighbours to extrapolate from.
  return {
    barHeight: `${BASELINE_HEIGHT_PX}px`,
    minHeight: `${BASELINE_HEIGHT_PX}px`,
  };
}

function FlatBar({ kind, isPreview }) {
  /* 占位/预测/真实零：单色背景条 */
  return (
    <div
      data-trend-bar="true"
      data-trend-kind={kind}
      className={cn(
        "h-full w-full group-hover:brightness-110 transition-all",
        kind === "real" ? "" : "bg-oai-gray-100 dark:bg-oai-gray-800",
      )}
      style={{
        opacity: isPreview ? PREVIEW_OPACITY : 1,
        background: kind === "real" ? "#10b981" : undefined,
      }}
    />
  );
}

function SegmentedBar({ segments, totalSegmentsValue }) {
  /* 堆叠拼接，自底向上绘制 */
  return segments.map((seg, sIdx) => {
    const segColor =
      seg.type === "token_type" ? TOKEN_COLORS[seg.name] : getModelColor(seg.name);
    const segHeight = `${(seg.value / totalSegmentsValue) * 100}%`;
    return (
      <div
        key={sIdx}
        data-trend-bar={sIdx === 0 ? "true" : undefined}
        className="w-full group-hover:brightness-110 transition-all"
        style={{
          height: segHeight,
          background: segColor,
        }}
      />
    );
  });
}

// Memoized so hover state in the parent (tooltip) doesn't re-render every
// bar on each mouseenter/mouseleave — props are all stable across hovers.
export const TrendBar = React.memo(function TrendBar({
  value,
  displayValue,
  scale,
  index,
  row,
  totalBars,
  onMouseEnter,
  onMouseLeave,
}) {
  const shouldReduceMotion = useReducedMotion();
  const kind = getBarKind(row, value);
  const isPreview = kind === "predicted" || kind === "unsynced";

  const heightPercent = scale.effectiveMax > 0 ? (displayValue / scale.effectiveMax) * 100 : 0;
  const { barHeight, minHeight } = getBarHeight(kind, heightPercent, isPreview);

  const segments = kind === "real" ? getBarSegments(row) : [];
  const totalSegmentsValue = segments.reduce((sum, s) => sum + s.value, 0);
  const renderFlat = kind !== "real" || totalSegmentsValue <= 0;

  return (
    <m.div
      className="group relative flex-1 self-stretch"
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={{
        duration: shouldReduceMotion ? 0 : 0.3,
        delay: shouldReduceMotion ? 0 : 0.4 + index * 0.008,
        ease: [0.16, 1, 0.3, 1],
      }}
      style={{ originY: 1 }}
      onMouseEnter={(e) => onMouseEnter(e, row, value, segments, kind, displayValue)}
      onMouseLeave={onMouseLeave}
    >
      {/* 纵向整列 Hover 引导条 */}
      <div className="absolute inset-x-0 top-0 bottom-0 bg-oai-gray-100/70 dark:bg-white/[0.08] opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none" />

      <div
        className="absolute inset-x-0 bottom-0 flex flex-col-reverse justify-start overflow-hidden cursor-pointer transition-all duration-200"
        style={{
          height: barHeight,
          minHeight,
        }}
      >
        {renderFlat ? (
          <FlatBar kind={kind} isPreview={isPreview} />
        ) : (
          <SegmentedBar segments={segments} totalSegmentsValue={totalSegmentsValue} />
        )}
      </div>
    </m.div>
  );
});
