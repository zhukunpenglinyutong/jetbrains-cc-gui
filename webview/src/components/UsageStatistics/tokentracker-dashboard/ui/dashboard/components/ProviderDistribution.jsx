import React, { useEffect, useMemo, useState } from "react";
import { m } from "motion/react";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { copy } from "../../../lib/copy";
import { getCurrencySymbol } from "../../../lib/currency";
import { formatProviderDisplayName } from "../../../lib/provider-display";
import { buildAllModels } from "../../../lib/model-breakdown";
import { AllToolsIcon } from "./AllToolsIcon.jsx";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { AllModelsSection, ProviderExpandedSection } from "./ProviderExpandedSection.jsx";
import {
  ALL_PROVIDERS_KEY,
  FULL_SHARE_LABEL,
  formatCost,
  formatPositiveTokens,
  formatProviderPercent,
  getProviderColor,
  getProviderPercentValue,
} from "./usageOverviewUtils.js";

// Provider Distribution: stacked share bar, per-provider cards, and the
// toggleable drill-down region below the grid.
export function ProviderDistribution({ fleetData, period, from, to, selectedDevice }) {
  const { currency, rate } = useCurrency();
  const { formatTokens } = useTokenFormat();
  // Nothing is expanded by default; every card toggles open/closed.
  const [expandedProvider, setExpandedProvider] = useState(null);
  // A new time/device scope collapses back to the card grid — drill-down
  // stays an explicit user action rather than a forced default.
  useEffect(() => {
    setExpandedProvider(null);
  }, [period, from, to, selectedDevice]);

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

  if (providers.length === 0) return null;

  return (
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
            <m.div
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
          {providers.flatMap((provider) => {
            if (provider.label !== activeProvider) return [];
            const color = getProviderColor(provider.label, 0);
            const sortedModels = [...provider.models].sort(
              (a, b) => (b.share || 0) - (a.share || 0)
            );

            const providerHeading = formatProviderDisplayName(provider.label);
            return [
              <ProviderExpandedSection
                key={provider.label}
                provider={provider}
                color={color}
                providerHeading={providerHeading}
                sortedModels={sortedModels}
              />,
            ];
          })}
        </div>
      )}

    </div>
  );
}
