import { copy } from "../../../lib/copy";

export const PALETTES = {
  emerald: {
    light: ["#ebedf0", "#a7f3d0", "#6ee7b7", "#34d399", "#10b981"],
    dark: ["#2d333b", "#065f46", "#059669", "#10b981", "#34d399"],
    gridColor: { light: "rgba(16, 185, 129, 0.12)", dark: "rgba(52, 211, 153, 0.08)" }
  },
  ocean: {
    light: ["#f1f5f9", "#93c5fd", "#60a5fa", "#3b82f6", "#1d4ed8"],
    dark: ["#1e293b", "#1e3a8a", "#2563eb", "#3b82f6", "#60a5fa"],
    gridColor: { light: "rgba(59, 130, 246, 0.12)", dark: "rgba(96, 165, 250, 0.08)" }
  },
  neon: {
    light: ["#faf5ff", "#ebd5ff", "#c084fc", "#a855f7", "#7e22ce"],
    dark: ["#2e1065", "#581c87", "#8b5cf6", "#a855f7", "#c084fc"],
    gridColor: { light: "rgba(168, 85, 247, 0.12)", dark: "rgba(192, 132, 252, 0.08)" }
  },
  amber: {
    light: ["#fffbeb", "#fde68a", "#f59e0b", "#d97706", "#b45309"],
    dark: ["#451a03", "#78350f", "#b45309", "#d97706", "#f59e0b"],
    gridColor: { light: "rgba(245, 158, 11, 0.12)", dark: "rgba(245, 158, 11, 0.08)" }
  }
};

export function shadeColor(hex, factor) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const c = (n) => Math.max(0, Math.min(255, Math.round(n * factor)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

export function rotatePoint(x, y, z, yaw, pitch) {
  // 1. 绕 Z 轴旋转 yaw (左右自转偏航)
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const x1 = x * cosY - y * sinY;
  const y1 = x * sinY + y * cosY;
  const z1 = z;

  // 2. 绕 X 轴旋转 pitch (上下俯仰)
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const x2 = x1;
  const y2 = y1 * cosP - z1 * sinP;
  const z2 = y1 * sinP + z1 * cosP;

  return { x: x2, y: y2, z: z2 };
}

// 旋转法向量（不含平移）
export function rotateVector(x, y, z, yaw, pitch) {
  return rotatePoint(x, y, z, yaw, pitch);
}

// AI 趣味数据洞察文案
export function getAITooltipMessage(level, value, formatter = (next) => Number(next).toLocaleString()) {
  const formatVal = formatter(value);
  if (level >= 4) {
    const index = Math.floor(Math.random() * 3) + 1;
    return copy(`heatmap.3d.voxel.joke.${index}`, { value: formatVal });
  } else if (level === 3) {
    return copy("heatmap.3d.voxel.level3", { value: formatVal });
  } else if (level === 2) {
    return copy("heatmap.3d.voxel.level2", { value: formatVal });
  } else if (level === 1) {
    return copy("heatmap.3d.voxel.level1", { value: formatVal });
  } else {
    return copy("heatmap.3d.voxel.level0");
  }
}

// 解析调色板（命名主题 / "auto" / 自定义颜色数组）为实际渲染颜色
export function resolvePalette(palette, isDark) {
  const selectedTheme = PALETTES[palette] || (palette === "auto" ? PALETTES.emerald : null);
  const colors = selectedTheme
    ? (isDark ? selectedTheme.dark : selectedTheme.light)
    : (Array.isArray(palette) ? palette : (isDark ? PALETTES.emerald.dark : PALETTES.emerald.light));
  const gridColor = selectedTheme
    ? (isDark ? selectedTheme.gridColor.dark : selectedTheme.gridColor.light)
    : (isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)");
  return { colors, gridColor };
}

// 将 Voxel 顶面中心的投影坐标换算为容器内的屏幕像素坐标，并做边缘自适应避让
export function computeTooltipScreenPos(svgEl, containerEl, projPoint, bounds, pad) {
  let screenX = 0;
  let screenY = 0;

  // 优先使用高级的 getScreenCTM 矩阵变换进行像素对齐，完全兼容 preserveAspectRatio 带来的偏移
  if (containerEl && typeof svgEl.createSVGPoint === "function" && typeof svgEl.getScreenCTM === "function") {
    try {
      const pt = svgEl.createSVGPoint();
      pt.x = projPoint.x;
      pt.y = projPoint.y;
      const ctm = svgEl.getScreenCTM();
      if (ctm) {
        const screenPoint = pt.matrixTransform(ctm);
        const containerRect = containerEl.getBoundingClientRect();
        screenX = screenPoint.x - containerRect.left;
        screenY = screenPoint.y - containerRect.top;
      }
    } catch (err) {
      // 降级使用基础比例计算
      const rect = svgEl.getBoundingClientRect();
      const viewWidth = bounds.maxX - bounds.minX + pad * 2;
      const viewHeight = bounds.maxY - bounds.minY + pad * 2;
      screenX = ((projPoint.x - (bounds.minX - pad)) / viewWidth) * rect.width;
      screenY = ((projPoint.y - (bounds.minY - pad)) / viewHeight) * rect.height;
    }
  } else {
    // 降级使用基础比例计算
    const rect = svgEl.getBoundingClientRect();
    const viewWidth = bounds.maxX - bounds.minX + pad * 2;
    const viewHeight = bounds.maxY - bounds.minY + pad * 2;
    screenX = ((projPoint.x - (bounds.minX - pad)) / viewWidth) * rect.width;
    screenY = ((projPoint.y - (bounds.minY - pad)) / viewHeight) * rect.height;
  }

  // 边缘自适应避让算法：卡片半宽设为 140 像素（含安全预留）
  const halfWidth = 140;
  let shiftX = 0;
  const containerWidth = containerEl ? containerEl.getBoundingClientRect().width : svgEl.getBoundingClientRect().width;
  if (screenX < halfWidth) {
    shiftX = halfWidth - screenX;
  } else if (screenX > containerWidth - halfWidth) {
    shiftX = (containerWidth - halfWidth) - screenX;
  }

  return { x: screenX, y: screenY, shiftX };
}
