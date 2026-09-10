// Shared by the ProjectDetailModal side panel stats and the BY SOURCE rows.
export function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  const pct = ratio * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}
