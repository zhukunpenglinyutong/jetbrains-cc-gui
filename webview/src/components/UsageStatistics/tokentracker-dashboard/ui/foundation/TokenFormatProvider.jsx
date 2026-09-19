import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocale } from "../../hooks/useLocale.js";
import { copy } from "../../lib/copy";
import {
  TOKEN_FORMAT_STORAGE_KEY,
  formatTokenCount,
  formatTokenTooltip,
  normalizeTokenFormatMode,
  persistTokenFormatMode,
  readTokenFormatMode,
} from "../../lib/token-format.js";

import { TokenFormatContext } from "./token-format-context.js";
export function TokenFormatProvider({ children }) {
  const { resolvedLocale } = useLocale();
  const [mode, setModeState] = useState(readTokenFormatMode);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== TOKEN_FORMAT_STORAGE_KEY) return;
      setModeState(normalizeTokenFormatMode(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = useCallback((value) => {
    const next = persistTokenFormatMode(value);
    setModeState(next);
  }, []);

  const suffixes = useMemo(
    () => ({
      thousandSuffix: copy("shared.unit.thousand_abbrev"),
      millionSuffix: copy("shared.unit.million_abbrev"),
      billionSuffix: copy("shared.unit.billion_abbrev"),
    }),
    [resolvedLocale],
  );

  const formatTokens = useCallback(
    (value, options = {}) => formatTokenCount(value, { mode, ...suffixes, ...options }),
    [mode, suffixes],
  );
  const formatTokensTooltip = useCallback(
    (value, options = {}) => formatTokenTooltip(value, { mode, ...suffixes, ...options }),
    [mode, suffixes],
  );

  const value = useMemo(
    () => ({ mode, setMode, formatTokens, formatTokensTooltip }),
    [formatTokens, formatTokensTooltip, mode, setMode],
  );

  return <TokenFormatContext.Provider value={value}>{children}</TokenFormatContext.Provider>;
}

export function TokenFormatModeOverride({ children, mode }) {
  const parent = useContext(TokenFormatContext);
  const scopedMode = normalizeTokenFormatMode(mode);

  const formatTokens = useCallback(
    (value, options = {}) => {
      if (parent) return parent.formatTokens(value, { ...options, mode: scopedMode });
      return formatTokenCount(value, { ...options, mode: scopedMode });
    },
    [parent, scopedMode],
  );
  const formatTokensTooltip = useCallback(
    (value, options = {}) => {
      if (parent) return parent.formatTokensTooltip(value, { ...options, mode: scopedMode });
      return formatTokenTooltip(value, { ...options, mode: scopedMode });
    },
    [parent, scopedMode],
  );
  const value = useMemo(
    () => ({
      mode: scopedMode,
      setMode: parent?.setMode ?? (() => {}),
      formatTokens,
      formatTokensTooltip,
    }),
    [formatTokens, formatTokensTooltip, parent?.setMode, scopedMode],
  );

  return <TokenFormatContext.Provider value={value}>{children}</TokenFormatContext.Provider>;
}
