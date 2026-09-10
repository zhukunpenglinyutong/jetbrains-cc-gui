import React, { useEffect, useRef } from "react";
import { SquareArrowOutUpRight } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Select } from "../../components/Select.jsx";
import { useDashboardPortalContainer } from "../../../hooks/useDashboardPortalContainer.js";
import { copy, getCopyLocale } from "../../../lib/copy";
import { DateRangePopover, formatDateShort, getDateFnsLocale } from "./DateRangePopover.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { normalizePeriods } from "./usageOverviewUtils.js";

// Header: Period Tabs + Refresh. Tabs are a single horizontal-scroll
// strip (never wrap into stacked rows); actions stay pinned right.
export function PeriodTabStrip({
  period,
  periods,
  onPeriodChange,
  customFrom,
  customTo,
  onCustomRangeApply,
  customRangeOpen,
  onCustomRangeOpenChange,
  onOpenShare,
  onRefresh,
  loading,
  deviceOptions,
  selectedDevice,
  onDeviceChange,
}) {
  const tabs = normalizePeriods(periods);
  const dateLocale = getDateFnsLocale(getCopyLocale());
  const portalContainer = useDashboardPortalContainer();
  // Keep the selected period chip in view when the tab strip scrolls
  // horizontally on narrow screens.
  const tablistRef = useRef(null);
  useEffect(() => {
    const el = tablistRef.current?.querySelector('[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [period]);

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

  return (
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
  );
}
