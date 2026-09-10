const sharedNumberFormatter = new Intl.NumberFormat();

export function toDisplayNumber(value: any) {
  if (value == null) return "-";
  try {
    if (typeof value === "bigint") return sharedNumberFormatter.format(value);
    if (typeof value === "number") return sharedNumberFormatter.format(value);
    const s = String(value).trim();
    if (/^[0-9]+$/.test(s)) return sharedNumberFormatter.format(BigInt(s));
    return s;
  } catch (_e) {
    return String(value);
  }
}

export function formatCompactNumber(
  value: any,
  {
    thousandSuffix = "K",
    millionSuffix = "M",
    billionSuffix = "B",
    decimals = 1,
  }: {
    thousandSuffix?: string;
    millionSuffix?: string;
    billionSuffix?: string;
    decimals?: number;
  } = {},
) {
  const n = Number(String(value));
  if (!Number.isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const safeDecimals = Math.max(0, Math.min(6, Math.floor(decimals)));

  if (abs < 1000) return `${sign}${String(abs)}`;

  const formatWithSuffix = (val: number, suffix: string) => {
    const fixed = val.toFixed(safeDecimals);
    const normalized = Number(fixed).toString();
    return `${sign}${normalized}${suffix}`;
  };

  const formatWithCarry = (val: number, suffix: string, nextSuffix?: string) => {
    const fixed = val.toFixed(safeDecimals);
    const normalized = Number(fixed);
    if (nextSuffix && normalized >= 1000) {
      return formatWithSuffix(normalized / 1000, nextSuffix);
    }
    return `${sign}${normalized.toString()}${suffix}`;
  };

  if (abs >= 1000000000) {
    return formatWithSuffix(abs / 1000000000, billionSuffix);
  }

  if (abs >= 1000000) {
    return formatWithCarry(abs / 1000000, millionSuffix, billionSuffix);
  }

  const kValue = abs / 1000;
  const roundedK = Number(kValue.toFixed(safeDecimals));
  if (roundedK >= 1000) {
    return formatWithSuffix(roundedK / 1000, millionSuffix);
  }
  return formatWithSuffix(roundedK, thousandSuffix);
}

export function toFiniteNumber(value: any) {
  const n = Number(String(value));
  return Number.isFinite(n) ? n : null;
}

import { getCurrencySymbol } from "./currency";

interface FormatUsdCurrencyOptions {
  decimals?: number;
  currency?: string;
  rate?: number;
}

/**
 * Format a USD value as currency. Pure function — accepts currency and rate
 * via options so React components can drive presentation via `useCurrency()`
 * and pure utilities (share cards, screenshots) can pass values explicitly.
 *
 * Returns "-" for null/undefined/empty/whitespace inputs and the raw string
 * for unparseable non-numeric inputs. Returns "$0.00" only for genuine 0/"0".
 */
export function formatUsdCurrency(value: any, options: FormatUsdCurrencyOptions = {}) {
  const { decimals = 2, currency = "USD", rate = 1 } = options;

  if (value == null) return "-";

  // Empty / whitespace must NOT coerce to 0 — that's a loading state, not "$0.00".
  if (typeof value === "string" && value.trim() === "") return "-";

  let numVal: number;
  if (typeof value === "number") {
    numVal = value;
  } else if (typeof value === "bigint") {
    numVal = Number(value);
  } else {
    const raw = String(value).trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return raw;
    numVal = parsed;
  }

  if (!Number.isFinite(numVal)) return String(value);

  const symbol = getCurrencySymbol(currency);
  if (currency !== "USD" && typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
    numVal = numVal * rate;
  }

  const fixed = numVal.toFixed(6);
  const match = fixed.match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!match) return `${symbol}${String(numVal)}`;
  const intPart = match[1];
  const fracPart = match[2] || "";
  let formattedInt = intPart;
  try {
    formattedInt = sharedNumberFormatter.format(BigInt(intPart));
  } catch (_e) {
    formattedInt = intPart;
  }
  const normalizedDecimals = Math.max(0, Math.min(6, Math.floor(decimals)));
  const decimalPart = normalizedDecimals
    ? fracPart.slice(0, normalizedDecimals).padEnd(normalizedDecimals, "0")
    : "";
  const sign = intPart.startsWith("-") ? "-" : "";
  const valuePart = normalizedDecimals
    ? `${formattedInt.replace("-", "")}.${decimalPart}`
    : formattedInt.replace("-", "");
  return `${sign}${symbol}${valuePart}`;
}
