// Summary-card values for DashboardPage: totals, cost, conversations, and
// the token-format toggle.
import { useCallback, useMemo } from "react";
import { copy } from "../lib/copy";
import { getNextTokenFormatMode } from "../lib/token-format.js";
import { formatUsdCurrency, toDisplayNumber } from "../lib/format";
import { getBillableTotal } from "./dashboardDataUtils.js";

export function useDashboardSummary({
  summary,
  formatTokens,
  tokenFormatMode,
  setTokenFormatMode,
  currency,
  rate,
}) {
  const summaryLabel = copy("usage.summary.total");
  const hasSummary = summary != null;
  const summaryTotalTokens = hasSummary ? getBillableTotal(summary) : 0;
  const summaryValue = formatTokens(summaryTotalTokens);
  const toggleSummaryFormat = useCallback(() => {
    setTokenFormatMode(getNextTokenFormatMode(tokenFormatMode));
  }, [setTokenFormatMode, tokenFormatMode]);

  const displayTotalTokens = toDisplayNumber(summaryTotalTokens);

  const summaryCostValue = useMemo(
    () => formatUsdCurrency(summary?.total_cost_usd, { currency, rate }),
    [summary?.total_cost_usd, currency, rate],
  );
  const summaryConversationsValue = useMemo(
    () => summary?.conversation_count ?? null,
    [summary?.conversation_count],
  );

  return {
    summaryLabel,
    hasSummary,
    summaryValue,
    displayTotalTokens,
    summaryCostValue,
    summaryConversationsValue,
    toggleSummaryFormat,
  };
}
