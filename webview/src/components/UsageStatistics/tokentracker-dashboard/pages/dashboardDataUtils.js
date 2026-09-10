// Shared pure helpers/constants for DashboardPage and its extracted hooks.
import { resolveDisplayTokens } from "../lib/model-breakdown";

export const PERIODS = ["day", "week", "month", "total", "custom"];
export const DETAILS_DATE_KEYS = new Set(["day", "hour", "month"]);
export const DETAILS_PAGED_PERIODS = new Set(["day", "total", "custom"]);

export function hasUsageValue(value, level) {
  if (typeof level === "number" && level > 0) return true;
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (/^[0-9]+$/.test(trimmed)) {
      try {
        return BigInt(trimmed) > 0n;
      } catch (_e) {
        return false;
      }
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) && numeric > 0;
  }
  return false;
}

export function getBillableTotal(row) {
  if (!row) return null;
  return resolveDisplayTokens(row, null);
}

export function getHeatmapValue(cell) {
  if (!cell) return null;
  return cell?.billable_total_tokens ?? cell?.value ?? cell?.total_tokens;
}
