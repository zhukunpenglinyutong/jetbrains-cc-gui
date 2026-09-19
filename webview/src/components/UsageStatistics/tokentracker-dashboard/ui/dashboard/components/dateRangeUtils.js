import { format } from "date-fns";
import { enUS, zhCN, zhTW, ja, ko } from "date-fns/locale";

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
