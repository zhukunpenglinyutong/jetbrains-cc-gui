import { useMemo } from "react";
import { rotatePoint, rotateVector, shadeColor } from "./activityHeatmap3dUtils";

export function useHeatmap3dScene({ weeks, interactive, angle, zoom, colors, isDark, growthWave }) {
  // 立方体尺寸常量
  const UNIT_SIZE = interactive ? 13 : 10.5;
  const GAP = interactive ? 1.8 : 1.5;
  const SIZE = UNIT_SIZE - GAP;
  const HEIGHT_MAX = interactive ? 38 : 28;

  // 3D grid lines on the floor (z = 0)
  const floorGridLines = useMemo(() => {
    const lines = [];
    const W = weeks.length;
    if (W === 0 || !interactive) return [];

    // Horizontal lines (along column direction, parallel to X axis)
    for (let r = 0; r <= 7; r++) {
      const y = (r - 3.5) * UNIT_SIZE;
      const p1 = rotatePoint((-W / 2) * UNIT_SIZE, y, 0, angle.yaw, angle.pitch);
      const p2 = rotatePoint((W / 2) * UNIT_SIZE, y, 0, angle.yaw, angle.pitch);
      lines.push({ d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, key: `horiz-${r}` });
    }

    // Vertical lines (along row direction, parallel to Y axis, every 4 weeks)
    for (let c = 0; c <= W; c += 4) {
      const x = (c - W / 2) * UNIT_SIZE;
      const p1 = rotatePoint(x, -3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      const p2 = rotatePoint(x, 3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      lines.push({ d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, key: `vert-${c}` });
    }

    if (W % 4 !== 0) {
      const x = (W - W / 2) * UNIT_SIZE;
      const p1 = rotatePoint(x, -3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      const p2 = rotatePoint(x, 3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      lines.push({ d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, key: `vert-last` });
    }

    return lines;
  }, [weeks.length, angle, UNIT_SIZE, interactive]);

  // 7. 三维空间投影计算
  const cells = useMemo(() => {
    const out = [];
    weeks.forEach((week, weekIdx) => {
      (Array.isArray(week) ? week : []).forEach((cell, dayIdx) => {
        if (!cell) return;
        out.push({
          key: cell.day || `${weekIdx}-${dayIdx}`,
          col: weekIdx,
          row: dayIdx,
          level: cell.level || 0,
          value: cell.value || 0,
          day: cell.day,
          models: cell.models || null,
        });
      });
    });
    return out;
  }, [weeks]);

  const levelToHeight = (level) => {
    // 0 级保留极薄的边缘厚度以供辨认
    return Math.max(1.8, (Number(level) / 4) * HEIGHT_MAX);
  };

  // 渲染正交投影后的 Voxel 几何面数据
  const projectedCells = useMemo(() => {
    if (cells.length === 0) return [];
    const W = weeks.length;

    return cells.map((c) => {
      const targetH = levelToHeight(c.level);
      // 水波波浪渐变生长：基于距离图表中心的距离产生延迟
      const distFromCenter = Math.sqrt(Math.pow(c.col - W / 2, 2) + Math.pow(c.row - 3.5, 2));
      const maxDist = Math.sqrt(Math.pow(W / 2, 2) + Math.pow(3.5, 2));
      const delay = (distFromCenter / maxDist) * 0.4; // 最大 0.4 延迟
      const cellProgress = Math.min(1, Math.max(0, (growthWave - delay) * (1 / 0.6)));

      const h = targetH * cellProgress;

      // 1. 三维空间中的中心坐标
      const xc = (c.col - W / 2) * UNIT_SIZE;
      const yc = (c.row - 3.5) * UNIT_SIZE;

      // 2. 立方体 8 个顶点的 3D 世界坐标
      const half = SIZE / 2;
      const pts = [
        { x: xc - half, y: yc - half, z: 0 }, // 0: 底左前
        { x: xc + half, y: yc - half, z: 0 }, // 1: 底右前
        { x: xc + half, y: yc + half, z: 0 }, // 2: 底右后
        { x: xc - half, y: yc + half, z: 0 }, // 3: 底左后
        { x: xc - half, y: yc - half, z: h }, // 4: 顶左前
        { x: xc + half, y: yc - half, z: h }, // 5: 顶右前
        { x: xc + half, y: yc + half, z: h }, // 6: 顶右后
        { x: xc - half, y: yc + half, z: h }, // 7: 顶左后
      ];

      // 3. 投影 8 个顶点到相机屏幕空间
      const proj = pts.map((p) => rotatePoint(p.x, p.y, p.z, angle.yaw, angle.pitch));

      // 4. 计算立方体中心旋转后的 Z 深度，用于画家算法排序
      const centerProj = rotatePoint(xc, yc, h / 2, angle.yaw, angle.pitch);

      // 5. 6 个面的配置与其在 3D 空间的标准法向量
      const facesConfig = [
        { name: "top", indices: [4, 5, 6, 7], scale: 1.0, normal: [0, 0, 1] },
        { name: "bottom", indices: [3, 2, 1, 0], scale: 0.4, normal: [0, 0, -1] },
        { name: "left", indices: [3, 0, 4, 7], scale: 0.55, normal: [-1, 0, 0] },
        { name: "right", indices: [1, 2, 6, 5], scale: 0.75, normal: [1, 0, 0] },
        { name: "front", indices: [0, 1, 5, 4], scale: 0.85, normal: [0, -1, 0] },
        { name: "back", indices: [2, 3, 7, 6], scale: 0.65, normal: [0, 1, 0] },
      ];

      const baseColor = colors[Math.min(4, Math.max(0, Number(c.level) || 0))];

      // 6. 相机空间内的背向消隐 (Back-face Culling) 与光影 (Shading)
      const renderedFaces = [];
      const lx = 0.35, ly = -0.4, lz = 0.83; // 虚拟光源位置（右上前方）

      facesConfig.forEach((f) => {
        // 计算旋转后的法向量
        const nRot = rotateVector(f.normal[0], f.normal[1], f.normal[2], angle.yaw, angle.pitch);

        // 深度大于 0 说明朝向观众（在相机坐标中 z+ 朝向观众）
        if (nRot.z > 0.001) {
          const p0 = proj[f.indices[0]];
          const p1 = proj[f.indices[1]];
          const p2 = proj[f.indices[2]];
          const p3 = proj[f.indices[3]];

          // 生成 SVG 路径
          const d = `M${p0.x},${p0.y} L${p1.x},${p1.y} L${p2.x},${p2.y} L${p3.x},${p3.y} Z`;

          // 根据朝向和世界光源计算光照强度的漫反射系数
          const dot = nRot.x * lx + nRot.y * ly + nRot.z * lz;
          // 在暗色模式下引入环境光（Ambient Light）保护，防止 3D 柱体侧面因光照系数过低而变成死黑，提升通透质感
          const ambient = isDark ? 0.18 : 0.0;
          const factor = f.scale * (0.82 + 0.28 * Math.max(0, dot)) + ambient;

          renderedFaces.push({
            name: f.name,
            d,
            fill: shadeColor(baseColor, factor),
          });
        }
      });

      return {
        ...c,
        centerProj,
        renderedFaces,
      };
    });
  }, [cells, angle, colors, weeks.length, growthWave, UNIT_SIZE, SIZE, HEIGHT_MAX]);

  // 8. 画家算法 (Painter's Algorithm)：由远及近（深度升序）排序渲染
  const sortedCells = useMemo(() => {
    return [...projectedCells].sort((a, b) => a.centerProj.z - b.centerProj.z);
  }, [projectedCells]);

  // 9. 计算 SVG 的包裹框大小
  const bounds = useMemo(() => {
    if (sortedCells.length === 0) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    sortedCells.forEach((c) => {
      // 这里的 centerProj 作为基础范围，加上立方体直径的适当缓冲
      const padding = UNIT_SIZE * 2;
      const x = c.centerProj.x;
      const y = c.centerProj.y;

      if (x - padding < minX) minX = x - padding;
      if (x + padding > maxX) maxX = x + padding;
      if (y - padding < minY) minY = y - padding;
      if (y + padding > maxY) maxY = y + padding;
    });

    // 稍微往底部加宽，给高 Voxel 预留空间
    return { minX, minY, maxX, maxY };
  }, [sortedCells, UNIT_SIZE]);

  const pad = 12;
  const width = bounds.maxX - bounds.minX + pad * 2;
  const height = bounds.maxY - bounds.minY + pad * 2;

  // 采用 viewBox 视口中心缩放机制实现平滑的滚轮/触控板手势缩放，且完全兼容 getScreenCTM 投影坐标换算
  const viewBoxWidth = width / zoom;
  const viewBoxHeight = height / zoom;
  const minX = bounds.minX - pad + (width - viewBoxWidth) / 2;
  const minY = bounds.minY - pad + (height - viewBoxHeight) / 2;
  const viewBox = `${minX} ${minY} ${viewBoxWidth} ${viewBoxHeight}`;

  return {
    UNIT_SIZE,
    floorGridLines,
    cells,
    levelToHeight,
    sortedCells,
    bounds,
    pad,
    width,
    height,
    viewBox,
  };
}
