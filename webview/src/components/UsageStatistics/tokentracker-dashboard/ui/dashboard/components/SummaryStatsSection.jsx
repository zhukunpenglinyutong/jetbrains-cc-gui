import React, { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Counter } from "../../components";
import { useTheme } from "../../../hooks/useTheme.js";
import { copy } from "../../../lib/copy";
import { SummaryValueSkeleton } from "./UsageOverviewSkeletons.jsx";
import { parseAnimatedCounterValue } from "./usageOverviewUtils.js";

// Main Stats: big animated summary number plus the optional cost line.
export function SummaryStatsSection({
  summaryValue,
  summaryFullValue,
  onToggleSummaryFormat,
  summaryLabel,
  summaryCostValue,
  onCostInfo,
  showSummarySkeleton,
}) {
  const summaryCounterValue = parseAnimatedCounterValue(String(summaryValue ?? ""));
  // The digit-by-digit Counter renders at a fixed 72px and would clip on
  // phones. Below sm we drop it and render the plain value, which scales
  // with the responsive font class below. 639px == one below Tailwind's
  // sm (640px), so this flips in lockstep with the sm: classes.
  const matchesCompact = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 639px)").matches;
  const [isCompactSummary, setIsCompactSummary] = useState(matchesCompact);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(max-width: 639px)");
    const onChange = (e) => setIsCompactSummary(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const showAnimatedSummary = summaryCounterValue != null && !isCompactSummary;
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const gradientFrom = isDark ? "rgba(10,10,10,0.98)" : "rgba(255,255,255,0.96)";
  const gradientTo = isDark ? "rgba(10,10,10,0)" : "rgba(255,255,255,0)";

  const summaryContent = showAnimatedSummary ? (
    <Counter
      value={summaryCounterValue}
      displayValue={summaryValue}
      fontSize={72}
      padding={6}
      gap={1}
      textColor="var(--oai-black, #111827)"
      fontWeight={700}
      gradientHeight={isDark ? 0 : 8}
      gradientFrom={gradientFrom}
      gradientTo={gradientTo}
      counterStyle={{ paddingLeft: 0, paddingRight: 0, gap: 0 }}
      digitStyle={{ width: "0.88ch" }}
    />
  ) : (
    summaryValue
  );

  return (
    <div className="text-center mb-8">
      <div className="text-xs text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wider mb-3">{summaryLabel}</div>
      <div className="relative text-5xl sm:text-6xl md:text-7xl font-bold text-oai-black dark:text-oai-white tracking-tight tabular-nums">
        <div className={showSummarySkeleton ? "invisible" : undefined}>
          {onToggleSummaryFormat ? (
            <button
              type="button"
              onClick={onToggleSummaryFormat}
              title={summaryFullValue || undefined}
              aria-label={copy("usage.summary.toggle_aria")}
              className="cursor-pointer rounded-lg leading-none transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand"
            >
              {summaryContent}
            </button>
          ) : (
            <span title={summaryFullValue || undefined}>{summaryContent}</span>
          )}
        </div>
        <div className={`absolute inset-0 flex items-center justify-center ${showSummarySkeleton ? "" : "hidden"}`}>
          <SummaryValueSkeleton />
        </div>
      </div>
      {summaryCostValue && (
        <div className="flex items-center justify-center gap-2 mt-4">
          {onCostInfo ? (
            <button
              type="button"
              onClick={onCostInfo}
              className="inline-flex items-center gap-1.5 text-xl font-bold text-oai-brand hover:text-oai-brand-dark dark:hover:text-oai-brand-light transition-colors cursor-pointer"
              aria-label={copy("usage.overview.cost_breakdown_aria")}
            >
              {summaryCostValue}
              <Info size={16} strokeWidth={2} className="opacity-80" />
            </button>
          ) : (
            <span className="text-xl font-bold text-oai-brand">{summaryCostValue}</span>
          )}
        </div>
      )}
    </div>
  );
}
