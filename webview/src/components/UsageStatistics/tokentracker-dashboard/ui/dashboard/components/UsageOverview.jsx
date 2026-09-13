import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Info, SquareArrowOutUpRight } from "lucide-react";

// Solid (fill-based) monochrome all-tools mark — matches the fill-based
// mono provider icons, unlike lucide's stroke-only Layers3. Drawn bold and
// edge-to-edge so it reads at the same visual weight as the sibling marks.
function AllToolsIcon({ size = 15, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 1.6 23 7.4 12 13.2 1 7.4 12 1.6Z" />
      <path d="m4 10.3-3 1.5 11 5.5 11-5.5-3-1.5-8 4-8-4Z" opacity="0.72" />
      <path d="m4 14.6-3 1.5 11 5.5 11-5.5-3-1.5-8 4-8-4Z" opacity="0.45" />
    </svg>
  );
}
import { Popover } from "@base-ui/react/popover";
import { Card, Button, Counter } from "../../components";
import { Select } from "../../components/Select.jsx";
import { useTheme } from "../../../hooks/useTheme.js";
import { useDashboardPortalContainer } from "../../../hooks/useDashboardPortalContainer.js";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { copy, getCopyLocale } from "../../../lib/copy";
import { CURRENCY_USD, getCurrencySymbol } from "../../../lib/currency";
import { formatProviderDisplayName } from "../../../lib/provider-display";
import { DateRangePopover, formatDateShort, getDateFnsLocale } from "./DateRangePopover.jsx";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { formatUsdCurrency } from "../../../lib/format";
import { buildAllModels } from "../../../lib/model-breakdown";

const ALL_PROVIDERS_KEY = "__all__";
const FULL_SHARE_LABEL = `${(100).toFixed(2)}%`;

function formatPositiveTokens(formatter, value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? formatter(n) : null;
}

function formatCost(value, currency, rate) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const symbol = getCurrencySymbol(currency);
  const converted = currency === CURRENCY_USD ? n : n * rate;
  if (converted < 0.01) return `<${symbol}0.01`;
  return formatUsdCurrency(n, { decimals: 2, currency, rate });
}

function normalizePeriods(periods) {
  if (!Array.isArray(periods)) return [];
  return periods.map((p) => {
    if (typeof p === "string") {
      return { key: p, label: getPeriodLabel(p) };
    }
    return { key: p.key, label: p.label || getPeriodLabel(p.key) };
  });
}

function parseAnimatedCounterValue(displayValue) {
  if (typeof displayValue !== "string") return null;
  const match = displayValue.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

// Provider color mapping for visual distinction
const PROVIDER_COLORS = {
  CODEX: "#3b82f6",     // blue-500
  CLAUDE: "#d97757",    // Anthropic Japonica orange-red
  OPENCODE: "#f59e0b",  // amber-500
  GEMINI: "#2196f3",    // Google Gemini bright blue
  KIMI: "#a78bfa",      // violet-400
  "KILO-CLI": "#facc15",   // yellow-400 (Kilo brand yellow)
  "KILO-CODE": "#facc15",
  MIMO: "#ff6900",         // Xiaomi MiMo brand orange
  DROID: "#ef4444",        // red-500 (Factory brand)
  ZCODE: "#14b8a6",        // teal-500 (Z.ai / GLM — distinct from the blues)
  ANYTHINGLLM: "var(--provider-anythingllm)", // AnythingLLM primary cyan
};

function getProviderColor(label, index) {
  const normalized = label?.toUpperCase?.() || "";
  return PROVIDER_COLORS[normalized] || `hsl(${150 + index * 40}, 60%, 45%)`;
}

function hasProviderModels(provider) {
  return Boolean(provider?.models?.length);
}

function getProviderPercentValue(provider) {
  const rawValue = Number(provider?.totalPercentValue ?? provider?.totalPercent);
  return Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
}

function formatProviderPercent(provider) {
  const value = getProviderPercentValue(provider);
  if (value > 0 && !(value >= 0.01)) return copy("usage.overview.percent_below_threshold");
  return value.toFixed(2);
}

const PERIOD_COPY_KEYS = {
  day: "usage.period.day",
  week: "usage.period.week",
  month: "usage.period.month",
  total: "usage.period.total",
  custom: "usage.period.custom",
};

function getPeriodLabel(key) {
  const copyKey = PERIOD_COPY_KEYS[key];
  return copyKey ? copy(copyKey) : String(key).toUpperCase();
}

// Refresh button with rotation animation
function RefreshButton({ loading, onClick }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={loading}
      onClick={onClick}
      aria-label={copy("usage.button.refresh")}
      className="w-8 p-0"
    >
      <motion.span
        aria-hidden="true"
        animate={loading ? { rotate: 360 } : { rotate: 0 }}
        transition={
          loading && !shouldReduceMotion
            ? { duration: 1, repeat: Infinity, ease: "linear" }
            : { duration: 0.3 }
        }
        style={{ display: "inline-block" }}
      >
        ↻
      </motion.span>
    </Button>
  );
}

function SummaryValueSkeleton() {
  return (
    <div
      data-testid="usage-summary-skeleton"
      aria-hidden="true"
      className="mx-auto h-[58px] sm:h-[72px] w-[min(72vw,18rem)] rounded-2xl bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse motion-reduce:animate-none"
    />
  );
}

function ProviderDistributionSkeleton() {
  return (
    <div
      data-testid="usage-provider-skeleton"
      aria-hidden="true"
      className="space-y-6"
    >
      <div className="h-1.5 w-full rounded-full bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse motion-reduce:animate-none" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-[92px] rounded-xl border border-oai-gray-100 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-800/60 animate-pulse motion-reduce:animate-none"
            style={{ animationDelay: `${index * 70}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

export function UsageOverview({
  period,
  periods,
  onPeriodChange,
  summaryValue,
  summaryFullValue,
  onToggleSummaryFormat,
  summaryLabel,
  summaryCostValue,
  onCostInfo,
  fleetData = [],
  onRefresh,
  loading,
  announceLoading = false,
  summaryLoading = false,
  providersLoading = false,
  hasSummary = true,
  className = "",
  customFrom,
  customTo,
  onCustomRangeApply,
  customRangeOpen,
  onCustomRangeOpenChange,
  onOpenShare,
  from,
  to,
  deviceOptions = [],
  selectedDevice = "",
  onDeviceChange,
}) {
  const tabs = normalizePeriods(periods);
  const dateLocale = getDateFnsLocale(getCopyLocale());
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
  // Keep the selected period chip in view when the tab strip scrolls
  // horizontally on narrow screens.
  const tablistRef = useRef(null);
  useEffect(() => {
    const el = tablistRef.current?.querySelector('[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [period]);
  // Nothing is expanded by default; every card toggles open/closed.
  const [expandedProvider, setExpandedProvider] = useState(null);
  const { resolvedTheme } = useTheme();
  const portalContainer = useDashboardPortalContainer();
  const { currency, rate } = useCurrency();
  const { formatTokens } = useTokenFormat();
  const isDark = resolvedTheme === "dark";
  const gradientFrom = isDark ? "rgba(10,10,10,0.98)" : "rgba(255,255,255,0.96)";
  const gradientTo = isDark ? "rgba(10,10,10,0)" : "rgba(255,255,255,0)";

  const showSummarySkeleton = summaryLoading && !hasSummary;
  const showProviderSkeleton = providersLoading && !fleetData.some(hasProviderModels);

  // A new time/device scope collapses back to the card grid — drill-down
  // stays an explicit user action rather than a forced default.
  useEffect(() => {
    setExpandedProvider(null);
  }, [period, from, to, selectedDevice]);

  const handleTablistKeyDown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabElements = Array.from(
      event.currentTarget.querySelectorAll('[role="tab"]'),
    ).filter((tab) => !tab.disabled);
    const currentIndex = tabElements.indexOf(event.target.closest('[role="tab"]'));
    if (currentIndex === -1 || tabElements.length === 0) return;

    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabElements.length - 1;
    else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabElements.length;
    else nextIndex = (currentIndex - 1 + tabElements.length) % tabElements.length;

    tabElements[nextIndex].focus();
    tabElements[nextIndex].click();
  };

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

  // FleetData is already grouped by provider.
  const providers = fleetData.filter((f) => f.models?.length > 0);
  const allModels = useMemo(() => buildAllModels(fleetData), [fleetData]);
  const allUsage = allModels.reduce((sum, model) => sum + (Number(model.usage) || 0), 0);
  const allCost = providers.reduce((sum, provider) => sum + (Number(provider.usd) || 0), 0);
  const activeProvider =
    expandedProvider == null
      ? null
      : expandedProvider === ALL_PROVIDERS_KEY || providers.some(function matchesExpandedProvider(provider) {
          return provider.label === expandedProvider;
        })
        ? expandedProvider
        : null;

  return (
    <Card className={className}>
      <div aria-busy={loading || showSummarySkeleton || showProviderSkeleton}>
        {announceLoading ? (
          <span className="sr-only" role="status">
            {copy("qpd.card.updating")}
          </span>
        ) : null}
        {/* Header: Period Tabs + Refresh. Tabs are a single horizontal-scroll
            strip (never wrap into stacked rows); actions stay pinned right. */}
        <div className="flex items-center gap-2 mb-6">
          <div ref={tablistRef} role="tablist" aria-label={copy("usage.overview.tablist_aria")} onKeyDown={handleTablistKeyDown} className="flex flex-1 min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((p) => {
              const isActive = period === p.key;
              const tabClass = `shrink-0 whitespace-nowrap text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                isActive
                  ? "text-oai-black dark:text-oai-white bg-oai-gray-100 dark:bg-oai-gray-800"
                  : "text-oai-gray-500 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800"
              }`;

              if (p.key === "custom") {
                const customLabel = isActive && customFrom && customTo
                  ? `${formatDateShort(customFrom, dateLocale)} — ${formatDateShort(customTo, dateLocale)}`
                  : p.label;

                return (
                  <Popover.Root
                    key="custom"
                    open={customRangeOpen}
                    onOpenChange={(open) => {
                      if (open) onPeriodChange?.("custom");
                      else onCustomRangeOpenChange?.(open);
                    }}
                  >
                    <Popover.Trigger
                      render={
                        <button
                          role="tab"
                          aria-selected={isActive}
                          tabIndex={isActive ? 0 : -1}
                          type="button"
                          className={tabClass}
                        />
                      }
                    >
                      {customLabel}
                    </Popover.Trigger>
                    <Popover.Portal container={portalContainer}>
                      <Popover.Positioner sideOffset={8} side="bottom" align="start" className="!z-[9999]">
                        <Popover.Popup className="bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded-xl shadow-lg">
                          <DateRangePopover
                            from={customFrom}
                            to={customTo}
                            onApply={onCustomRangeApply}
                            onCancel={() => onCustomRangeOpenChange?.(false)}
                          />
                        </Popover.Popup>
                      </Popover.Positioner>
                    </Popover.Portal>
                  </Popover.Root>
                );
              }

              return (
                <button
                  key={p.key}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  type="button"
                  className={tabClass}
                  onClick={() => onPeriodChange?.(p.key)}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {deviceOptions.length > 1 ? (
              <Select
                value={selectedDevice}
                onValueChange={onDeviceChange}
                options={deviceOptions}
                ariaLabel={copy("dashboard.device_filter.aria")}
                matchTriggerWidth
                className="h-8 px-3 text-xs font-medium rounded-md border-oai-gray-300 dark:border-oai-gray-700 bg-oai-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white hover:border-oai-brand hover:text-oai-brand hover:[&_svg]:text-oai-brand transition-colors duration-200"
              />
            ) : null}
            {onOpenShare ? (
              <button
                type="button"
                onClick={onOpenShare}
                aria-label={copy("share.button.aria")}
                className="inline-flex items-center justify-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-oai-gray-300 dark:border-oai-gray-700 bg-oai-white dark:bg-oai-gray-900 text-oai-black dark:text-oai-white hover:border-oai-brand hover:text-oai-brand transition-colors duration-200"
              >
                <SquareArrowOutUpRight className="h-3.5 w-3.5" strokeWidth={2} />
                {copy("share.button.label")}
              </button>
            ) : null}
            {onRefresh && (
              <RefreshButton loading={loading} onClick={onRefresh} />
            )}
          </div>
        </div>

        {/* Main Stats */}
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

        {/* Provider Distribution */}
        <div className={showProviderSkeleton ? undefined : "hidden"}>
          <ProviderDistributionSkeleton />
        </div>
        {providers.length > 0 && (
          <div className="space-y-6">
            {/* Distribution Bar */}
            <div
              role="img"
              aria-label={copy("usage.overview.distribution_aria", {
                items: providers
                  .map((provider) =>
                    copy("usage.overview.distribution_item", {
                      label: formatProviderDisplayName(provider.label),
                      percent: formatProviderPercent(provider),
                    }),
                  )
                  .join("，"),
              })}
              className="h-1.5 w-full bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden flex"
            >
              {providers.map((provider, idx) => {
                const color = getProviderColor(provider.label, idx);
                const displayLabel = formatProviderDisplayName(provider.label);
                const percentLabel = formatProviderPercent(provider);
                return (
                  <motion.div
                    key={provider.label}
                    initial={{ width: 0 }}
                    animate={{ width: `${getProviderPercentValue(provider)}%` }}
                    transition={{ duration: 0.5, delay: 0.45 + idx * 0.04, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full"
                    style={{ backgroundColor: color }}
                    title={`${displayLabel}: ${percentLabel}%`}
                  />
                );
              })}
            </div>

            {/* Provider Cards — responsive grid keeps cells equal-width so the
                last row never stretches when the count doesn't divide evenly. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              <button
                type="button"
                aria-expanded={activeProvider === ALL_PROVIDERS_KEY}
                aria-controls="provider-details-all"
                aria-label={copy("usage.overview.all_tools_card_aria", {
                  tokens: formatPositiveTokens(formatTokens, allUsage) || String(0),
                  cost: formatCost(allCost, currency, rate) || `${getCurrencySymbol(currency)}0`,
                  count: allModels.length,
                })}
                onClick={() =>
                  setExpandedProvider(
                    activeProvider === ALL_PROVIDERS_KEY ? null : ALL_PROVIDERS_KEY,
                  )
                }
                className={`min-w-0 text-left p-3 rounded-lg border transition-colors duration-200 ${
                  activeProvider === ALL_PROVIDERS_KEY
                    ? "border-oai-gray-300 dark:border-oai-gray-600 bg-oai-gray-50 dark:bg-oai-gray-800"
                    : "border-oai-gray-200 dark:border-oai-gray-700 hover:border-oai-gray-300 dark:hover:border-oai-gray-600"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1 min-w-0">
                  <AllToolsIcon size={15} className="shrink-0 text-oai-brand dark:text-oai-white" />
                  <span className="text-sm font-medium text-oai-black dark:text-oai-white truncate">
                    {copy("usage.overview.all_tools")}
                  </span>
                </div>
                <div className="text-lg font-semibold text-oai-black dark:text-oai-white tabular-nums">
                  {FULL_SHARE_LABEL}
                </div>
                <div className="mt-0.5 text-[11px] text-oai-gray-400 dark:text-oai-gray-400 tabular-nums">
                  {copy("usage.overview.model_count", { count: allModels.length })}
                </div>
              </button>
              {providers.map((provider, idx) => {
                const color = getProviderColor(provider.label, idx);
                const isExpanded = activeProvider === provider.label;
                const displayLabel = formatProviderDisplayName(provider.label);
                const percentLabel = formatProviderPercent(provider);

                return (
                  <button
                    key={provider.label}
                    aria-expanded={isExpanded}
                    aria-controls={`provider-details-${provider.label}`}
                    aria-label={copy("usage.overview.provider_card_aria", {
                      provider: displayLabel,
                      percent: percentLabel,
                      tokens: formatPositiveTokens(formatTokens, provider.usage) || String(0),
                      cost: formatCost(provider.usd, currency, rate) || `${getCurrencySymbol(currency)}0`,
                      action: copy(isExpanded ? "usage.overview.collapse" : "usage.overview.expand"),
                    })}
                    onClick={() => setExpandedProvider(isExpanded ? null : provider.label)}
                    className={`min-w-0 text-left p-3 rounded-lg border transition-colors duration-200 ${
                      isExpanded
                        ? "border-oai-gray-300 dark:border-oai-gray-600 bg-oai-gray-50 dark:bg-oai-gray-800"
                        : "border-oai-gray-200 dark:border-oai-gray-700 hover:border-oai-gray-300 dark:hover:border-oai-gray-600"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 min-w-0">
                      <ProviderIcon provider={provider.label} size={15} color={color} className="text-oai-gray-700 dark:text-oai-gray-300 shrink-0" />
                      <span className="text-sm font-medium text-oai-black dark:text-oai-white truncate" title={displayLabel}>{displayLabel}</span>
                    </div>
                    <div className="text-lg font-semibold text-oai-black dark:text-oai-white tabular-nums">
                      {percentLabel}%
                    </div>
                    <div className="mt-0.5 text-[11px] text-oai-gray-400 dark:text-oai-gray-400 tabular-nums">
                      {copy("usage.overview.model_count", { count: provider.models.length })}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* A card toggles its details region; collapsed by default. (Two
                sibling && guards, not a nested ternary — the ui-hardcode
                scanner reads `) : x ? (` fragments as raw JSX text.) */}
            {activeProvider === ALL_PROVIDERS_KEY && (
              <div
                id="provider-details-all"
                role="region"
                aria-label={copy("usage.overview.all_models")}
                className="mt-2"
              >
                <AllModelsSection models={allModels} />
              </div>
            )}
            {activeProvider != null && activeProvider !== ALL_PROVIDERS_KEY && (
              <div
                id={`provider-details-${activeProvider}`}
                role="region"
                aria-label={copy("usage.overview.model_details_aria", {
                  provider: activeProvider,
                })}
                className="mt-2"
              >
                {providers
                  .filter((p) => p.label === activeProvider)
                  .map((provider) => {
                    const color = getProviderColor(provider.label, 0);
                    const sortedModels = [...provider.models].sort(
                      (a, b) => (b.share || 0) - (a.share || 0)
                    );

                    const providerHeading = formatProviderDisplayName(provider.label);
                    return (
                      <ProviderExpandedSection
                        key={provider.label}
                        provider={provider}
                        color={color}
                        providerHeading={providerHeading}
                        sortedModels={sortedModels}
                      />
                    );
                  })}
              </div>
            )}

          </div>
        )}
      </div>
      </Card>
  );
}

// Renders a single expanded provider section.
function ModelUsageRows({ models, color }) {
  const { currency, rate } = useCurrency();
  const { formatTokens, formatTokensTooltip } = useTokenFormat();

  return (
    <div className="space-y-3">
      {models.map((model) => {
        const tokensLabel = formatPositiveTokens(formatTokens, model.usage);
        const costLabel = formatCost(model.cost, currency, rate);
        const clampedShare = Math.max(0, Math.min(100, Number(model.share) || 0));
        return (
          <div key={model.id || model.name} data-model-rank-row>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,max-content)_minmax(5.5rem,max-content)_4rem] items-baseline gap-x-3 mb-1.5">
              <span
                className="col-start-1 row-start-1 min-w-0 text-sm text-oai-gray-700 dark:text-oai-gray-300 truncate"
                title={model.name}
              >
                {model.name}
              </span>
              <span
                title={formatTokensTooltip(model.usage)}
                className="col-start-2 row-start-1 text-right whitespace-nowrap text-sm text-oai-gray-500 dark:text-oai-gray-400 tabular-nums"
              >
                {tokensLabel}
              </span>
              <span className="col-start-3 row-start-1 text-right whitespace-nowrap text-sm text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                {costLabel}
              </span>
              <span className="col-start-4 row-start-1 text-right whitespace-nowrap text-sm text-oai-black dark:text-oai-white tabular-nums">
                {model.share}%
              </span>
            </div>
            <div
              className="h-[3px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden"
              role="progressbar"
              aria-valuenow={clampedShare}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full transition-[width] duration-500 ease-out"
                style={{
                  width: `${clampedShare}%`,
                  backgroundColor: color,
                  opacity: 0.45,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AllModelsSection({ models }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <AllToolsIcon size={14} className="shrink-0 text-oai-brand dark:text-oai-white" />
        <span className="text-sm font-medium text-oai-black dark:text-oai-white">
          {copy("usage.overview.all_models")}
        </span>
      </div>
      <p className="mb-4 text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400">
        {copy("usage.overview.all_models_note")}
      </p>
      <ModelUsageRows models={models} color="var(--oai-blue)" />
    </div>
  );
}

function ProviderExpandedSection({ provider, color, providerHeading, sortedModels }) {
  const { formatTokens } = useTokenFormat();
  const isAntigravity =
    String(provider?.source || provider?.label || "").trim().toLowerCase() === "antigravity";

  return (
                      <div>
                        {/* Section header — provider identity. */}
                        <div className="flex items-center gap-1.5 mb-3">
                          <ProviderIcon provider={provider.label} size={14} color={color} className="shrink-0" />
                          <span className="text-sm font-medium text-oai-black dark:text-oai-white">{providerHeading}</span>
                        </div>

                        {/* Input-side cache hit rate for this provider. Omitted
                            entirely when the source does no prompt caching (rate
                            is null) so we never render a misleading 0%. */}
                        {provider.cacheHitRate != null && (
                          <p className="mb-3 text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
                            <span className="font-medium text-oai-gray-600 dark:text-oai-gray-300">
                              {copy("usage.overview.cache_hit_rate_label")}
                            </span>{" "}
                            <span className="text-oai-black dark:text-oai-white">{provider.cacheHitRate}%</span>
                            {" · "}
                            {copy("usage.overview.cache_hit_rate_detail", {
                              reused: formatPositiveTokens(formatTokens, provider.cacheReusedTokens) || String(0),
                              input: formatPositiveTokens(formatTokens, provider.cacheInputTokens) || String(0),
                            })}
                          </p>
                        )}

                        {/* Antigravity transcripts carry no usage field — every token
                            here is a 4-char/token estimate that ignores Gemini prompt
                            caching. Inline footnote, same muted style as the Context
                            Breakdown footnote. */}
                        {isAntigravity && (
                          <p className="mb-3 text-[10px] leading-snug text-oai-gray-400 dark:text-oai-gray-500">
                            <span className="font-medium text-oai-gray-500 dark:text-oai-gray-400">
                              {copy("usage.overview.antigravity_notice_title")}.
                            </span>{" "}
                            {copy("usage.overview.antigravity_notice_body")}
                          </p>
                        )}

                        {/* Model rows — text line + thin muted bar as visual rhythm */}
                        <ModelUsageRows models={sortedModels} color={color} />
                      </div>
  );
}
