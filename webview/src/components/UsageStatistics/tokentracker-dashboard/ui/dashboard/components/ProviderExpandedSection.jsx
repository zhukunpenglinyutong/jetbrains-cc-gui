import React from "react";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { copy } from "../../../lib/copy";
import { AllToolsIcon } from "./AllToolsIcon.jsx";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { formatCost, formatPositiveTokens } from "./usageOverviewUtils.js";

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

export function AllModelsSection({ models }) {
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

export function ProviderExpandedSection({ provider, color, providerHeading, sortedModels }) {
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
