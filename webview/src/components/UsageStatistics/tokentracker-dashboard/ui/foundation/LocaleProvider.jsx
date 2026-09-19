import React, { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { setCopyLocale } from "../../lib/copy";
import {
  getInitialLocalePreference,
  normalizeLocalePreference,
  persistLocalePreference,
  resolvePreferredLocale,
  SYSTEM_LOCALE,
} from "../../lib/locale";
import { isNativeEmbed, setNativeSetting } from "../../lib/native-bridge.js";

import { LocaleContext } from "./locale-context.js";
function getInitialResolvedLocale() {
  return resolvePreferredLocale(getInitialLocalePreference());
}

function applyDocumentLanguage(locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

function syncResolvedLocale(locale, setResolvedLocale) {
  setCopyLocale(locale);
  setResolvedLocale((prev) => (prev === locale ? prev : locale));
}

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(getInitialLocalePreference);
  const [resolvedLocale, setResolvedLocale] = useState(getInitialResolvedLocale);

  useLayoutEffect(() => {
    applyDocumentLanguage(resolvedLocale);
  }, [resolvedLocale]);

  useLayoutEffect(() => {
    if (!isNativeEmbed()) return;
    setNativeSetting("locale", locale);
  }, [locale]);

  useLayoutEffect(() => {
    if (locale !== SYSTEM_LOCALE || typeof window === "undefined") return undefined;
    const handleChange = () => syncResolvedLocale(resolvePreferredLocale(SYSTEM_LOCALE), setResolvedLocale);
    window.addEventListener("languagechange", handleChange);
    return () => window.removeEventListener("languagechange", handleChange);
  }, [locale]);

  const setLocale = useCallback((value) => {
    const next = normalizeLocalePreference(value);
    syncResolvedLocale(resolvePreferredLocale(next), setResolvedLocale);
    setLocaleState(next);
    persistLocalePreference(next);
    if (isNativeEmbed()) {
      setNativeSetting("locale", next);
    }
  }, []);

  const contextValue = useMemo(
    () => ({ locale, setLocale, resolvedLocale }),
    [locale, resolvedLocale, setLocale],
  );

  return <LocaleContext.Provider value={contextValue}>{children}</LocaleContext.Provider>;
}
