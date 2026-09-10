import { useEffect, useState } from "react";

// Owns the 2D/3D view preference: the standalone dashboard persists it to
// localStorage, embedded hosts (e.g. the leaderboard profile modal) always
// render the compact 2D grid, and the 2D grid scrolls to the latest
// (rightmost) month whenever it (re)mounts.
export function useHeatmapView({ embedded, scrollRef, weeks }) {
  const [view, setView] = useState(() => {
    // Embedded hosts (e.g. the leaderboard profile modal) have no 2D/3D
    // toggle and must always render the compact 2D grid. Ignore the persisted
    // dashboard preference so a user who picked 3D on the dashboard doesn't
    // see 3D inside the modal.
    if (embedded) return "2d";
    try {
      const stored = window.localStorage?.getItem("tt:heatmap-view");
      return stored === "3d" ? "3d" : "2d";
    } catch {
      return "2d";
    }
  });
  useEffect(() => {
    // Only the standalone dashboard owns the persisted preference; embedded
    // instances must not write it back (would clobber the dashboard's 3D pick).
    if (embedded) return;
    try { window.localStorage?.setItem("tt:heatmap-view", view); } catch { /* ignore */ }
  }, [view, embedded]);

  useEffect(() => {
    // Re-run on `view` too: the 2D grid is conditionally rendered, so when the
    // user starts in 3D the scroll container isn't mounted. Switching to 2D
    // mounts it fresh at scrollLeft=0 (oldest months) — without `view` in the
    // deps this effect wouldn't fire again and the grid would default to ~12
    // months ago instead of the current month (rightmost).
    if (view !== "2d") return;
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks, view]);

  return { view, setView };
}
