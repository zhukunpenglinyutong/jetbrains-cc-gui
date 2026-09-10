import React from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { DateRangePopover } from "./DateRangePopover.jsx";
import { useDashboardPortalContainer } from "../../../hooks/useDashboardPortalContainer.js";
import { GRANULARITIES, shiftDay } from "./trendZoomUtils";

// Controls row: granularity tabs + the day navigator (30-min view) or the
// range picker (Day/Month views).
export function TrendMonitorZoomControls({
  zoomPeriod,
  onSelectGranularity,
  selectedDay,
  maxDay,
  onSelectDay,
  rangeSel,
  onSelectRange,
}) {
  const portalContainer = useDashboardPortalContainer();
  const [dayPickerOpen, setDayPickerOpen] = React.useState(false);
  const [rangePickerOpen, setRangePickerOpen] = React.useState(false);

  const canPrevDay = zoomPeriod === "day" && !!selectedDay;
  const canNextDay = zoomPeriod === "day" && !!selectedDay && (!maxDay || selectedDay < maxDay);

  return (
    <div className="flex items-center justify-between gap-3 mb-6 pr-10">
      {/* Granularity tabs */}
      <div
        role="tablist"
        aria-label={copy("trend.zoom.gran.aria")}
        className="flex rounded-md border border-oai-gray-200 dark:border-oai-gray-800 p-0.5 text-[11px]"
      >
        {GRANULARITIES.map((g) => (
          <button
            key={g.period}
            type="button"
            role="tab"
            aria-selected={zoomPeriod === g.period}
            onClick={() => onSelectGranularity(g.period)}
            className={cn(
              "px-2.5 py-1 rounded transition-colors",
              zoomPeriod === g.period
                ? "bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-oai-white font-medium"
                : "text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200",
            )}
          >
            {copy(g.labelKey)}
          </button>
        ))}
      </div>

      {/* Day navigation (30-min view only) */}
      {zoomPeriod === "day" ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => canPrevDay && onSelectDay((d) => shiftDay(d, -1))}
            disabled={!canPrevDay}
            aria-label={copy("trend.zoom.prev_day")}
            className="p-1 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <Popover.Root open={dayPickerOpen} onOpenChange={setDayPickerOpen}>
            <Popover.Trigger
              aria-label={copy("trend.zoom.pick_day")}
              className="text-[12px] font-medium text-oai-gray-700 dark:text-oai-gray-200 tabular-nums min-w-[100px] text-center px-2 py-0.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
            >
              {selectedDay || "—"}
            </Popover.Trigger>
            <Popover.Portal container={portalContainer}>
              <Popover.Positioner sideOffset={8} side="bottom" align="center" className="!z-[9999]">
                <Popover.Popup className="bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded-xl shadow-lg">
                  <DateRangePopover
                    from={selectedDay}
                    to={selectedDay}
                    onApply={(fromStr) => {
                      if (fromStr) onSelectDay(fromStr);
                      setDayPickerOpen(false);
                    }}
                    onCancel={() => setDayPickerOpen(false)}
                  />
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          <button
            type="button"
            onClick={() => canNextDay && onSelectDay((d) => shiftDay(d, 1))}
            disabled={!canNextDay}
            aria-label={copy("trend.zoom.next_day")}
            className="p-1 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      ) : (
        <Popover.Root open={rangePickerOpen} onOpenChange={setRangePickerOpen}>
          <Popover.Trigger
            aria-label={copy("trend.zoom.pick_range")}
            className="text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300 tabular-nums px-2.5 py-1 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors select-none"
          >
            {rangeSel.from && rangeSel.to
              ? rangeSel.from === rangeSel.to
                ? rangeSel.from
                : `${rangeSel.from} → ${rangeSel.to}`
              : "—"}
          </Popover.Trigger>
          <Popover.Portal container={portalContainer}>
            <Popover.Positioner sideOffset={8} side="bottom" align="end" className="!z-[9999]">
              <Popover.Popup className="bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded-xl shadow-lg">
                <DateRangePopover
                  from={rangeSel.from}
                  to={rangeSel.to}
                  onApply={(f, t) => {
                    if (f) onSelectRange({ from: f, to: t || f });
                    setRangePickerOpen(false);
                  }}
                  onCancel={() => setRangePickerOpen(false)}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}
