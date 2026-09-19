import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CURRENCY_USD,
  DEFAULT_RATES,
  getCurrencySymbol,
  getInitialCurrency,
  getInitialExchangeRates,
  getRateFor,
  isValidRate,
  normalizeCurrency,
  persistCurrency,
  persistExchangeRates,
} from "../../lib/currency";
import { fetchUsdRates, shouldRefetch } from "../../lib/exchange-rate";
import { isNativeEmbed, setNativeSetting } from "../../lib/native-bridge.js";

import { CurrencyContext } from "./currency-context.js";
function pushNative(currency, rate, symbol) {
  if (!isNativeEmbed()) return;
  setNativeSetting("currency", currency);
  setNativeSetting("currencySymbol", symbol);
  if (isValidRate(rate)) setNativeSetting("exchangeRate", rate);
}

export function CurrencyProvider({ children }) {
  const [currency, setCurrencyState] = useState(getInitialCurrency);
  const initial = useMemo(() => getInitialExchangeRates(), []);
  const [rates, setRates] = useState(initial.rates);
  const [rateSource, setRateSource] = useState(initial.source);
  const [rateFetchedAt, setRateFetchedAt] = useState(initial.fetchedAt);
  const fetchingRef = useRef(false);
  const triedFetchRef = useRef(false);

  const applyRates = useCallback((nextRates, nextSource, nextFetchedAt) => {
    setRates(nextRates);
    setRateSource(nextSource);
    setRateFetchedAt(nextFetchedAt);
    persistExchangeRates({ rates: nextRates, source: nextSource, fetchedAt: nextFetchedAt });
  }, []);

  const refreshRates = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const { rates: fetched, fetchedAt } = await fetchUsdRates();
      // Merge with bundled defaults so unsupported codes still have a fallback.
      applyRates({ ...DEFAULT_RATES, ...fetched }, "fetched", fetchedAt);
    } catch (_e) {
      // graceful degrade — keep existing cached/default rates
    } finally {
      fetchingRef.current = false;
    }
  }, [applyRates]);

  const setCurrency = useCallback(
    (value) => {
      const next = normalizeCurrency(value);
      setCurrencyState(next);
      persistCurrency(next);
      const rate = getRateFor(rates, next);
      const symbol = getCurrencySymbol(next);
      pushNative(next, rate, symbol);
    },
    [rates],
  );

  // First mount or stale cache: if a non-USD currency is active, try a
  // background refresh. Failure is silent — UI shows cached / bundled defaults.
  useEffect(() => {
    if (triedFetchRef.current) return;
    if (currency === CURRENCY_USD) return;
    if (!shouldRefetch(rateFetchedAt)) return;
    triedFetchRef.current = true;
    refreshRates();
  }, [currency, rateFetchedAt, refreshRates]);

  // Keep Swift side in sync with current selection + rate + symbol after
  // app relaunch (UserDefaults may diverge from localStorage).
  useEffect(() => {
    const rate = getRateFor(rates, currency);
    const symbol = getCurrencySymbol(currency);
    pushNative(currency, rate, symbol);
  }, [currency, rates]);

  const rate = useMemo(() => getRateFor(rates, currency), [rates, currency]);
  const symbol = useMemo(() => getCurrencySymbol(currency), [currency]);

  const value = useMemo(
    () => ({
      currency,
      rate,
      symbol,
      rates,
      rateSource,
      rateFetchedAt,
      setCurrency,
    }),
    [currency, rate, symbol, rates, rateSource, rateFetchedAt, setCurrency],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}
