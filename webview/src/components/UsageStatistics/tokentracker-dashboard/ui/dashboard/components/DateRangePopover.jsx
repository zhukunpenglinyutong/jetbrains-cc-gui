import React, { useState, useMemo } from "react";
import { DayPicker } from "react-day-picker";
import { format } from "date-fns";
import { enUS, zhCN, zhTW, ja, ko } from "date-fns/locale";
import { Button } from "../../components";
import { copy, getCopyLocale } from "../../../lib/copy";

// Map the dashboard's resolved locale to a date-fns locale object so the
// calendar (month captions + weekday headers) and the in-popover date summary
// render in the selected language instead of always English.
const DATE_FNS_LOCALES = {
  en: enUS,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
};

/** Resolve a dashboard locale (en/zh-CN/zh-TW/ja/ko) to a date-fns Locale. */
export function getDateFnsLocale(resolvedLocale) {
  return DATE_FNS_LOCALES[resolvedLocale] || enUS;
}

/**
 * Format a YYYY-MM-DD string to short display like "Mar 1".
 * Pass a date-fns `locale` (see getDateFnsLocale) to localize the month name.
 */
export function formatDateShort(dateStr, locale) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (!Number.isFinite(d.getTime())) return dateStr;
  return format(d, "MMM d", locale ? { locale } : undefined);
}

/**
 * Calendar-based date range picker content.
 * Renders two months side-by-side with range selection.
 */
export function DateRangePopover({ from, to, onApply, onCancel }) {
  const initialRange = useMemo(() => {
    const result = { from: undefined, to: undefined };
    if (from) {
      const fp = from.split("-");
      result.from = new Date(Number(fp[0]), Number(fp[1]) - 1, Number(fp[2]));
    }
    if (to) {
      const tp = to.split("-");
      result.to = new Date(Number(tp[0]), Number(tp[1]) - 1, Number(tp[2]));
    }
    return result;
  }, [from, to]);

  const [range, setRange] = useState(initialRange);

  const dateLocale = getDateFnsLocale(getCopyLocale());

  const handleApply = () => {
    if (!range?.from) return;
    const fromStr = format(range.from, "yyyy-MM-dd");
    const toStr = range.to ? format(range.to, "yyyy-MM-dd") : fromStr;
    onApply?.(fromStr, toStr);
  };

  const hasSelection = !!range?.from;

  return (
    <div className="p-4">
      <DayPicker
        mode="range"
        locale={dateLocale}
        selected={range}
        onSelect={setRange}
        numberOfMonths={2}
        showOutsideDays={false}
        classNames={{
          root: "rdp-oai",
          months: "flex gap-4",
          month: "space-y-3",
          month_caption: "flex justify-center items-center h-8",
          caption_label: "text-sm font-medium text-oai-black dark:text-oai-white",
          nav: "flex items-center justify-between absolute inset-x-0 top-0 px-2",
          button_previous: "inline-flex items-center justify-center w-7 h-7 rounded-md text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-oai-white hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors",
          button_next: "inline-flex items-center justify-center w-7 h-7 rounded-md text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-oai-white hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors",
          chevron: "w-4 h-4 fill-current",
          month_grid: "border-collapse",
          weekdays: "flex",
          weekday: "w-9 text-center text-xs font-medium text-oai-gray-400 dark:text-oai-gray-500 py-1",
          week: "flex",
          day: "w-9 h-9 text-center text-sm p-0 relative",
          day_button: "w-full h-full inline-flex items-center justify-center rounded-md transition-colors hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 text-oai-black dark:text-oai-white cursor-pointer rdp-day-btn",
          today: "font-bold",
          selected: "rdp-selected",
          range_start: "rdp-selected rdp-range-start",
          range_end: "rdp-selected rdp-range-end",
          range_middle: "rdp-range-mid",
          outside: "text-oai-gray-300 dark:text-oai-gray-600",
          disabled: "text-oai-gray-300 dark:text-oai-gray-600 cursor-not-allowed",
          hidden: "invisible",
        }}
        styles={{
          months: { position: "relative" },
        }}
      />
      <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-oai-gray-200 dark:border-oai-gray-700">
        {hasSelection && range.from && (
          <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mr-auto">
            {format(range.from, "MMM d, yyyy", { locale: dateLocale })}
            {range.to && range.to.getTime() !== range.from.getTime()
              ? ` — ${format(range.to, "MMM d, yyyy", { locale: dateLocale })}`
              : ""}
          </span>
        )}
        {hasSelection && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRange({ from: undefined, to: undefined })}
          >
            {copy("shared.action.clear")}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {copy("shared.action.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={handleApply} disabled={!hasSelection}>
          {copy("shared.action.apply")}
        </Button>
      </div>
    </div>
  );
}
