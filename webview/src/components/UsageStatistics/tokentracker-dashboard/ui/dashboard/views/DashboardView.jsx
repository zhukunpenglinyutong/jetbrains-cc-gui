// Vendored from upstream src/ui/dashboard/views/DashboardView.jsx with the
// dnd-kit drag ordering, auth gates, skeleton and the removed cards
// (MacAppBanner / WidgetOnboarding / DeviceUsage / QualityPerDollar /
// SessionInsights / CostAnalysisModal / ShareModal entry) stripped out.
// Renders the five kept cards in the upstream fixed order, using the same
// FadeIn stagger as upstream's screenshotMode branch.
import React from "react";
import { LazyMotion, domAnimation } from "motion/react";
import { Shell } from "../../components";
import { DataDetails } from "../components/DataDetails.jsx";
import { StatsPanel } from "../components/StatsPanel.jsx";
import { UsageOverview } from "../components/UsageOverview.jsx";
import { TrendMonitor } from "../components/TrendMonitor.jsx";
import { FadeIn } from "../../foundation/FadeIn.jsx";

// Entrance stagger timing — matches upstream's screenshotMode fixed-order
// branch (the drag-order path used the same per-index formula).
const STEP = 0.06;
const D_LEFT_BASE = 0.11;
const D_RIGHT_BASE = 0.05;

// Upstream order minus the removed cards (macAppBanner / widgetOnboarding /
// installCopy / deviceUsage / qualityPerDollar / sessionInsights).
const LEFT_CARD_ORDER = ["statsPanel", "activityHeatmap", "trendMonitor"];
const RIGHT_CARD_ORDER = ["usageOverview", "dataDetails"];

export function DashboardView(props) {

  const {
    copy,
    identityStartDate,
    activeDays,
    identitySubscriptions,
    projectUsageEntries,
    projectUsageLimit,
    setProjectUsageLimit,
    projectDetailQuery,
    topModels,
    trendRowsForDisplay,
    trendFromForDisplay,
    trendToForDisplay,
    trendZoomConfig,
    usageFrom,
    usageTo,
    period,
    trendTimeZoneLabel,
    activityHeatmapBlock,
    periodsForDisplay,
    setSelectedPeriod,
    customFrom,
    customTo,
    onCustomRangeApply,
    customRangeOpen,
    onCustomRangeOpenChange,
    summaryLabel,
    summaryValue,
    summaryFullValue,
    hasSummary,
    summaryLoading,
    providersLoading,
    onToggleSummaryFormat,
    summaryCostValue,
    summaryConversationsValue,
    rollingUsage,
    refreshAll,
    usageLoadingState,
    announceUsageLoading,
    fleetData,
    hasDetailsActual,
    dailyEmptyPrefix,
    installSyncCmd,
    dailyEmptySuffix,
    detailsColumns,
    ariaSortFor,
    toggleSort,
    sortIconFor,
    pagedDetails,
    dailyBreakdownRows,
    dailyBreakdownColumns,
    dailyBreakdownAriaSortFor,
    dailyBreakdownSortIconFor,
    dailyBreakdownDateKey,
    detailsDateKey,
    renderDetailDate,
    renderDailyBreakdownDate,
    renderDetailCell,
    DETAILS_PAGED_PERIODS,
    detailsPageCount,
    detailsPage,
    setDetailsPage,
  } = props;

  // Header 和 Footer 已简化
  const header = null;
  const footer = null;

  function renderLeftCard(id, delay) {
    switch (id) {
      case "statsPanel": {
        return (
          <FadeIn delay={delay}>
            <StatsPanel
              title={copy("dashboard.identity.title")}
              subtitle={copy("dashboard.identity.subtitle")}
              period={period}
              startDate={identityStartDate ?? copy("identity_card.rank_placeholder")}
              streakDays={activeDays}
              subscriptions={identitySubscriptions}
              periodConversations={summaryConversationsValue}
              rolling={rollingUsage}
              topModels={topModels}
            />
          </FadeIn>
        );
      }
      case "activityHeatmap": {
        return <FadeIn delay={delay}>{activityHeatmapBlock}</FadeIn>;
      }
      case "trendMonitor": {
        return (
          <FadeIn delay={delay}>
            <TrendMonitor
              rows={trendRowsForDisplay}
              from={trendFromForDisplay}
              to={trendToForDisplay}
              period={period}
              timeZoneLabel={trendTimeZoneLabel}
              showTimeZoneLabel={false}
              zoomConfig={trendZoomConfig}
            />
          </FadeIn>
        );
      }
      default: {
        return null;
      }
    }
  }

  function renderRightCard(id, delay) {
    switch (id) {
      case "usageOverview": {
        return (
          <FadeIn delay={delay}>
            <UsageOverview
              period={period}
              periods={periodsForDisplay}
              onPeriodChange={setSelectedPeriod}
              summaryLabel={summaryLabel}
              summaryValue={summaryValue}
              summaryFullValue={summaryFullValue}
              hasSummary={hasSummary}
              summaryLoading={summaryLoading}
              providersLoading={providersLoading}
              onToggleSummaryFormat={hasSummary ? onToggleSummaryFormat : null}
              summaryCostValue={summaryCostValue}
              onCostInfo={null}
              fleetData={fleetData}
              onRefresh={refreshAll}
              loading={usageLoadingState}
              announceLoading={announceUsageLoading}
              onOpenShare={null}
              customFrom={customFrom}
              customTo={customTo}
              onCustomRangeApply={onCustomRangeApply}
              customRangeOpen={customRangeOpen}
              onCustomRangeOpenChange={onCustomRangeOpenChange}
              from={usageFrom}
              to={usageTo}
              deviceOptions={[]}
            />
          </FadeIn>
        );
      }
      case "dataDetails": {
        return (
          <FadeIn delay={delay}>
            <DataDetails
              projectEntries={projectUsageEntries}
              projectLimit={projectUsageLimit}
              onProjectLimitChange={setProjectUsageLimit}
              projectDetailQuery={projectDetailQuery}
              copy={copy}
              hasDetailsActual={hasDetailsActual}
              dailyEmptyPrefix={dailyEmptyPrefix}
              installSyncCmd={installSyncCmd}
              dailyEmptySuffix={dailyEmptySuffix}
              detailsColumns={detailsColumns}
              ariaSortFor={ariaSortFor}
              toggleSort={toggleSort}
              sortIconFor={sortIconFor}
              pagedDetails={pagedDetails}
              dailyBreakdownRows={dailyBreakdownRows}
              dailyBreakdownColumns={dailyBreakdownColumns}
              dailyBreakdownAriaSortFor={dailyBreakdownAriaSortFor}
              dailyBreakdownSortIconFor={dailyBreakdownSortIconFor}
              dailyBreakdownDateKey={dailyBreakdownDateKey}
              detailsDateKey={detailsDateKey}
              renderDetailDate={renderDetailDate}
              renderDailyBreakdownDate={renderDailyBreakdownDate}
              renderDetailCell={renderDetailCell}
              DETAILS_PAGED_PERIODS={DETAILS_PAGED_PERIODS}
              period={period}
              detailsPageCount={detailsPageCount}
              detailsPage={detailsPage}
              setDetailsPage={setDetailsPage}
            />
          </FadeIn>
        );
      }
      default: {
        return null;
      }
    }
  }

  const leftColumnContent = LEFT_CARD_ORDER.map((id, i) => (
    <React.Fragment key={id}>{renderLeftCard(id, D_LEFT_BASE + STEP * i)}</React.Fragment>
  ));
  const rightColumnContent = RIGHT_CARD_ORDER.map((id, i) => (
    <React.Fragment key={id}>{renderRightCard(id, D_RIGHT_BASE + STEP * i)}</React.Fragment>
  ));

  return (
    <LazyMotion features={domAnimation}>
    <Shell bare header={header} footer={footer}>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4 flex flex-col gap-4 min-w-0 order-2 lg:order-1">
          {leftColumnContent}
        </div>

        <div className="lg:col-span-8 flex flex-col gap-4 min-w-0 order-1 lg:order-2">
          {rightColumnContent}
        </div>
      </div>
    </Shell>
    </LazyMotion>
  );
}
