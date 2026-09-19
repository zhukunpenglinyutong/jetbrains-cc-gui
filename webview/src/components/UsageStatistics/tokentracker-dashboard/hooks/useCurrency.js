import { useContext } from "react";
import { CurrencyContext } from "../ui/foundation/currency-context.js";
import { CURRENCY_USD, DEFAULT_RATES } from "../lib/currency";

const FALLBACK_CURRENCY_VALUE = Object.freeze({
  currency: CURRENCY_USD,
  rate: 1,
  symbol: "$",
  rates: { ...DEFAULT_RATES },
  rateSource: "default",
  rateFetchedAt: null,
  setCurrency: () => {},
});

export function useCurrency() {
  // Fall back to a stable USD@1 value when no provider is mounted (test renders,
  // share-card screenshot harness, error boundaries). This keeps pure-display
  // components renderable in isolation and never throws unexpectedly.
  const ctx = useContext(CurrencyContext);
  return ctx ?? FALLBACK_CURRENCY_VALUE;
}
