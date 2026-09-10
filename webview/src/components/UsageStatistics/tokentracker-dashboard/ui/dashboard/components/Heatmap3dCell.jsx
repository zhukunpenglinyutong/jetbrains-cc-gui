import React from "react";
import { copy } from "../../../lib/copy";

export function Heatmap3dCell({ cell, interactive, isHovered, onMouseEnter, onMouseLeave, formatTokensTooltip }) {
  return (
    <g
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="transition-all duration-200"
      style={{
        filter: isHovered ? "brightness(1.15) drop-shadow(0 4px 6px rgba(0,0,0,0.15))" : "none",
        cursor: interactive ? "pointer" : "default"
      }}
    >
      {!interactive && cell.day && (
        <title>
          {copy("heatmap.tooltip.tokens", {
            day: cell.day,
            value: formatTokensTooltip(cell.value),
          })}
        </title>
      )}
      {cell.renderedFaces.map((f, idx) => (
        <path
          key={idx}
          d={f.d}
          fill={f.fill}
          stroke={f.fill} // 补充描边以抹平浮点像素缝隙误差，形成无瑕立体感
          strokeWidth={0.25}
          strokeLinejoin="round"
        />
      ))}
    </g>
  );
}
