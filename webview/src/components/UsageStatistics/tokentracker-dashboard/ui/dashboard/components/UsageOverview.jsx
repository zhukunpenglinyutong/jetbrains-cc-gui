import React from "react";
import { Card } from "../../components";
import { copy } from "../../../lib/copy";
import { PeriodTabStrip } from "./PeriodTabStrip.jsx";
import { SummaryStatsSection } from "./SummaryStatsSection.jsx";
import { ProviderDistributionSkeleton } from "./UsageOverviewSkeletons.jsx";
import { ProviderDistribution } from "./ProviderDistribution.jsx";
import { EMPTY_LIST, hasProviderModels } from "./usageOverviewUtils.js";

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
  fleetData = EMPTY_LIST,
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
  deviceOptions = EMPTY_LIST,
  selectedDevice = "",
  onDeviceChange,
}) {
  const showSummarySkeleton = summaryLoading && !hasSummary;
  const showProviderSkeleton = providersLoading && !fleetData.some(hasProviderModels);

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
        <PeriodTabStrip
          period={period}
          periods={periods}
          onPeriodChange={onPeriodChange}
          customFrom={customFrom}
          customTo={customTo}
          onCustomRangeApply={onCustomRangeApply}
          customRangeOpen={customRangeOpen}
          onCustomRangeOpenChange={onCustomRangeOpenChange}
          onOpenShare={onOpenShare}
          onRefresh={onRefresh}
          loading={loading}
          deviceOptions={deviceOptions}
          selectedDevice={selectedDevice}
          onDeviceChange={onDeviceChange}
        />

        {/* Main Stats */}
        <SummaryStatsSection
          summaryValue={summaryValue}
          summaryFullValue={summaryFullValue}
          onToggleSummaryFormat={onToggleSummaryFormat}
          summaryLabel={summaryLabel}
          summaryCostValue={summaryCostValue}
          onCostInfo={onCostInfo}
          showSummarySkeleton={showSummarySkeleton}
        />

        {/* Provider Distribution */}
        <div className={showProviderSkeleton ? undefined : "hidden"}>
          <ProviderDistributionSkeleton />
        </div>
        <ProviderDistribution
          fleetData={fleetData}
          period={period}
          from={from}
          to={to}
          selectedDevice={selectedDevice}
        />
      </div>
      </Card>
  );
}
