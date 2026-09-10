import { buildActivityHeatmap } from "../../../lib/activity-heatmap";
import { copy } from "../../../lib/copy";

export const CELL_SIZE = 12;
export const CELL_GAP = 3;
export const LABEL_WIDTH = 26;

export const HEATMAP_COLORS_LIGHT = [
  "#ebedf0", // level 0 - inactive, GitHub-style neutral
  "#a7f3d0", // level 1
  "#6ee7b7", // level 2
  "#34d399", // level 3
  "#10b981", // level 4
];

export const HEATMAP_COLORS_DARK = [
  "#121212", // level 0 - inactive, ultra-dark neutral for OLED-black integration
  "#065f46", // level 1
  "#059669", // level 2
  "#10b981", // level 3
  "#34d399", // level 4 - brightest
];

export const PALETTE_ACCENTS = {
  emerald: {
    accentText: "text-emerald-500 dark:text-emerald-400",
    accentBg: "bg-emerald-500/10 dark:bg-emerald-400/10",
    accentBorder: "border-emerald-500/20 dark:border-emerald-400/15",
    hoverBorder: "hover:border-emerald-500/30 dark:hover:border-emerald-400/30",
    hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(16,185,129,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(52,211,153,0.25)]",
    rawColor: "#10b981"
  },
  ocean: {
    accentText: "text-blue-500 dark:text-blue-400",
    accentBg: "bg-blue-500/10 dark:bg-blue-400/10",
    accentBorder: "border-blue-500/20 dark:border-blue-400/15",
    hoverBorder: "hover:border-blue-500/30 dark:hover:border-blue-400/30",
    hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(59,130,246,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(96,165,250,0.25)]",
    rawColor: "#3b82f6"
  },
  neon: {
    accentText: "text-purple-500 dark:text-purple-400",
    accentBg: "bg-purple-500/10 dark:bg-purple-400/10",
    accentBorder: "border-purple-500/20 dark:border-purple-400/15",
    hoverBorder: "hover:border-purple-500/30 dark:hover:border-purple-400/30",
    hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(168,85,247,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(192,132,252,0.25)]",
    rawColor: "#a855f7"
  },
  amber: {
    accentText: "text-amber-500 dark:text-amber-400",
    accentBg: "bg-amber-500/10 dark:bg-amber-400/10",
    accentBorder: "border-amber-500/20 dark:border-amber-400/15",
    hoverBorder: "hover:border-amber-500/30 dark:hover:border-amber-400/30",
    hoverGlow: "hover:shadow-[0_0_20px_-3px_rgba(245,158,11,0.15)] hover:dark:shadow-[0_0_20px_-3px_rgba(245,158,11,0.25)]",
    rawColor: "#f59e0b"
  }
};

export function parseUtcDate(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

export function addUtcDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function diffUtcDays(a, b) {
  return Math.floor(
    (Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
      Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) /
      86400000
  );
}

export function getWeekStart(date, weekStartsOn) {
  const desired = weekStartsOn === "mon" ? 1 : 0;
  const dow = date.getUTCDay();
  return addUtcDays(date, -((dow - desired + 7) % 7));
}

export function buildMonthMarkers(weeksCount, to, weekStartsOn, monthLabels) {
  if (!weeksCount) return [];
  const end = parseUtcDate(to) || new Date();
  const months = [];
  for (let i = 11; i >= 0; i -= 1) {
    months.push(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1)));
  }

  const endWeekStart = getWeekStart(end, weekStartsOn);
  const startAligned = addUtcDays(endWeekStart, -(weeksCount - 1) * 7);

  const markers = [];
  const used = new Set();
  for (const month of months) {
    const idx = Math.floor(diffUtcDays(startAligned, month) / 7);
    if (idx < 0 || idx >= weeksCount || used.has(idx)) continue;
    used.add(idx);
    markers.push({ label: monthLabels[month.getUTCMonth()], index: idx });
  }
  return markers;
}

// 动态感知多语言月份 labels
export function getMonthLabels() {
  return [
    copy("heatmap.month.jan"),
    copy("heatmap.month.feb"),
    copy("heatmap.month.mar"),
    copy("heatmap.month.apr"),
    copy("heatmap.month.may"),
    copy("heatmap.month.jun"),
    copy("heatmap.month.jul"),
    copy("heatmap.month.aug"),
    copy("heatmap.month.sep"),
    copy("heatmap.month.oct"),
    copy("heatmap.month.nov"),
    copy("heatmap.month.dec"),
  ];
}

export function getDayLabels(weekStartsOn) {
  return weekStartsOn === "mon"
    ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => copy(`heatmap.day.${d.toLowerCase()}`))
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => copy(`heatmap.day.${d.toLowerCase()}`));
}

export function normalizeHeatmap(heatmap, weekStartsOn) {
  const source = Array.isArray(heatmap?.weeks) ? heatmap.weeks : [];
  if (!source.length) return { weeks: [] };

  const rows = [];
  for (const week of source) {
    for (const cell of Array.isArray(week) ? week : []) {
      if (!cell?.day) continue;

      rows.push({
        day: cell.day,
        total_tokens: cell.total_tokens ?? cell.value ?? 0,
        billable_total_tokens: cell.billable_total_tokens ?? cell.value ?? cell.total_tokens ?? 0,
        models: cell.models ?? null,
      });
    }
  }

  return buildActivityHeatmap({
    dailyRows: rows,
    weeks: Math.max(52, source.length),
    to: heatmap?.to,
    weekStartsOn,
  });
}

// 动态计算年度 Token 洞察统计数据
export function computeHeatmapStats(weeks, rawCost) {
  let totalTokens = 0;
  let activeDays = 0;
  let maxSingleDay = { day: null, value: 0 };
  let currentStreak = 0;
  let maxStreak = 0;

  const allCells = [];
  weeks.forEach((w) => {
    (Array.isArray(w) ? w : []).forEach((c) => {
      if (c && c.day) {
        allCells.push(c);
      }
    });
  });
  allCells.sort((a, b) => a.day.localeCompare(b.day));

  allCells.forEach((c) => {
    const val = Number(c.value) || 0;
    totalTokens += val;
    if (val > 0) {
      activeDays++;
      currentStreak++;
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
      }
    } else {
      currentStreak = 0;
    }
    if (val > maxSingleDay.value) {
      maxSingleDay = { day: c.day, value: val };
    }
  });

  const totalDays = allCells.length || 365;
  const activeRate = totalDays ? ((activeDays / totalDays) * 100).toFixed(1) : "0.0";

  // AI 年度高阶技术人文评述 (去除塑料感，融入工程师深度共情)
  let aiEvaluationKey = "heatmap.3d.modal.ai.eval.default";
  let aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.default";

  if (totalTokens >= 15000000) {
    aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.peak";
    aiEvaluationKey = "heatmap.3d.modal.ai.eval.peak";
  } else if (totalTokens >= 5000000) {
    aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.heavy";
    aiEvaluationKey = "heatmap.3d.modal.ai.eval.heavy";
  } else if (totalTokens >= 1000000) {
    aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.core";
    aiEvaluationKey = "heatmap.3d.modal.ai.eval.core";
  } else if (totalTokens >= 20000) {
    aiEvaluationTitleKey = "heatmap.3d.modal.ai.title.steady";
    aiEvaluationKey = "heatmap.3d.modal.ai.eval.steady";
  }

  // 取得年度总消耗费用（后端提供精准计算，前端针对 Mock 数据或历史缓存做备用估算兜底）
  const parsedCost = Number(rawCost);
  const hasUsableCost =
    rawCost != null &&
    (typeof rawCost !== "string" || rawCost.trim() !== "") &&
    Number.isFinite(parsedCost);
  const totalCostUsd = hasUsableCost ? parsedCost : (totalTokens / 1500000.0);

  return {
    totalTokens,
    activeDays,
    activeRate,
    maxSingleDay,
    maxStreak,
    aiEvaluationTitleKey,
    aiEvaluationKey,
    totalCostUsd,
  };
}

// Modal fade/scale motion shared by the 3D insight modal backdrop & container.
export const HEATMAP_STYLE_CSS = `
  @keyframes tt-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes tt-fade-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  @keyframes tt-modal-entrance {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(10px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
  @keyframes tt-modal-exit {
    from {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
    to {
      opacity: 0;
      transform: scale(0.96) translateY(10px);
    }
  }
  .animate-tt-fade-in {
    animation: tt-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .animate-tt-fade-out {
    animation: tt-fade-out 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .animate-tt-modal {
    animation: tt-modal-entrance 0.3s cubic-bezier(0.34, 1.3, 0.64, 1) forwards;
  }
  .animate-tt-modal-exit {
    animation: tt-modal-exit 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
`;
