import { useEffect, useState } from "react";

/**
 * Portal container for Base UI overlays (Popover/Select/Toast/...).
 *
 * Base UI portals to <body> by default, which escapes the `.tt-dashboard`
 * scope: the scoped preflight, the scoped `--oai-*` custom properties and the
 * `dark:` variant (`.tt-dashboard.dark`) then no longer apply, so a portaled
 * popup renders with unreset, light-mode browser styles (most visible on the
 * react-day-picker range calendar: default gray bordered <button> day cells
 * on a white panel while the dashboard is dark).
 *
 * Portaling into the `.tt-dashboard` wrapper keeps overlay content inside the
 * scope so all of the above work again. Returns null until mounted (the
 * wrapper is an ancestor, so it always exists by then); Base UI falls back to
 * <body> for a null container, which only matters before the first effect.
 */
export function useDashboardPortalContainer() {
  const [container, setContainer] = useState(null);
  useEffect(() => {
    setContainer(document.querySelector(".tt-dashboard"));
  }, []);
  return container;
}
