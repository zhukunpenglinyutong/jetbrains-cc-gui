import { copy } from "../../../lib/copy";
import { CURRENCY_USD, getCurrencySymbol } from "../../../lib/currency";
import { formatUsdCurrency } from "../../../lib/format";

// Hoisted so destructuring defaults don't create a fresh reference per render.
export const EMPTY_LIST = [];

export const ALL_PROVIDERS_KEY = "__all__";
export const FULL_SHARE_LABEL = `${(100).toFixed(2)}%`;

export function formatPositiveTokens(formatter, value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? formatter(n) : null;
}

export function formatCost(value, currency, rate) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const symbol = getCurrencySymbol(currency);
  const converted = currency === CURRENCY_USD ? n : n * rate;
  if (converted < 0.01) return `<${symbol}0.01`;
  return formatUsdCurrency(n, { decimals: 2, currency, rate });
}

export function normalizePeriods(periods) {
  if (!Array.isArray(periods)) return [];
  return periods.map((p) => {
    if (typeof p === "string") {
      return { key: p, label: getPeriodLabel(p) };
    }
    return { key: p.key, label: p.label || getPeriodLabel(p.key) };
  });
}

export function parseAnimatedCounterValue(displayValue) {
  if (typeof displayValue !== "string") return null;
  const match = displayValue.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

// Provider color mapping for visual distinction
const PROVIDER_COLORS = {
  CODEX: "#3b82f6",     // blue-500
  CLAUDE: "#d97757",    // Anthropic Japonica orange-red
  OPENCODE: "#f59e0b",  // amber-500
  GEMINI: "#2196f3",    // Google Gemini bright blue
  KIMI: "#a78bfa",      // violet-400
  "KILO-CLI": "#facc15",   // yellow-400 (Kilo brand yellow)
  "KILO-CODE": "#facc15",
  MIMO: "#ff6900",         // Xiaomi MiMo brand orange
  DROID: "#ef4444",        // red-500 (Factory brand)
  ZCODE: "#14b8a6",        // teal-500 (Z.ai / GLM — distinct from the blues)
  ANYTHINGLLM: "var(--provider-anythingllm)", // AnythingLLM primary cyan
};

export function getProviderColor(label, index) {
  const normalized = label?.toUpperCase?.() || "";
  return PROVIDER_COLORS[normalized] || `hsl(${150 + index * 40}, 60%, 45%)`;
}

export function hasProviderModels(provider) {
  return Boolean(provider?.models?.length);
}

export function getProviderPercentValue(provider) {
  const rawValue = Number(provider?.totalPercentValue ?? provider?.totalPercent);
  return Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
}

export function formatProviderPercent(provider) {
  const value = getProviderPercentValue(provider);
  if (value > 0 && !(value >= 0.01)) return copy("usage.overview.percent_below_threshold");
  return value.toFixed(2);
}

const PERIOD_COPY_KEYS = {
  day: "usage.period.day",
  week: "usage.period.week",
  month: "usage.period.month",
  total: "usage.period.total",
  custom: "usage.period.custom",
};

export function getPeriodLabel(key) {
  const copyKey = PERIOD_COPY_KEYS[key];
  return copyKey ? copy(copyKey) : String(key).toUpperCase();
}
