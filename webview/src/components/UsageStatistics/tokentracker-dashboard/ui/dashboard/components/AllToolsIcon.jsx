import React from "react";

// Solid (fill-based) monochrome all-tools mark — matches the fill-based
// mono provider icons, unlike lucide's stroke-only Layers3. Drawn bold and
// edge-to-edge so it reads at the same visual weight as the sibling marks.
export function AllToolsIcon({ size = 15, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 1.6 23 7.4 12 13.2 1 7.4 12 1.6Z" />
      <path d="m4 10.3-3 1.5 11 5.5 11-5.5-3-1.5-8 4-8-4Z" opacity="0.72" />
      <path d="m4 14.6-3 1.5 11 5.5 11-5.5-3-1.5-8 4-8-4Z" opacity="0.45" />
    </svg>
  );
}
