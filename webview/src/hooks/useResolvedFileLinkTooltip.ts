import { useCallback, useEffect, useRef } from 'react';
import { resolveFilePathWithCallback } from '../utils/bridge';
import { useFloatingTextTooltip } from './useFloatingTextTooltip';

const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const UNC_PATH_REGEX = /^[\\/]{2}/;

const isAbsoluteFilePath = (path: string): boolean => (
  path.startsWith('/') || WINDOWS_ABSOLUTE_PATH_REGEX.test(path) || UNC_PATH_REGEX.test(path)
);

const getSafeFallbackText = (text: string | undefined): string | undefined => {
  if (!text || isAbsoluteFilePath(text)) {
    return undefined;
  }
  return text;
};

export function useResolvedFileLinkTooltip(
  filePath: string | undefined,
  fallbackText: string | undefined,
): {
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
} {
  const tooltip = useFloatingTextTooltip();
  const resolvedTextCacheRef = useRef<Map<string, string>>(new Map());
  const currentHoverPathRef = useRef<string | undefined>(undefined);
  const currentTooltipTextRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const latestMousePositionRef = useRef({ clientX: 0, clientY: 0 });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      currentHoverPathRef.current = undefined;
      currentTooltipTextRef.current = undefined;
      tooltip.hideTooltip();
    };
  }, [tooltip]);

  const onMouseEnter = useCallback((e: React.MouseEvent) => {
    latestMousePositionRef.current = { clientX: e.clientX, clientY: e.clientY };
    currentHoverPathRef.current = filePath;
    currentTooltipTextRef.current = undefined;
    tooltip.hideTooltip();

    const fallback = getSafeFallbackText(fallbackText);
    if (!filePath) {
      if (fallback) {
        currentTooltipTextRef.current = fallback;
        tooltip.showTooltip(fallback, e.clientX, e.clientY);
      }
      return;
    }

    const cachedText = resolvedTextCacheRef.current.get(filePath);
    const initialText = cachedText ?? fallback;
    if (initialText) {
      currentTooltipTextRef.current = initialText;
      tooltip.showTooltip(initialText, e.clientX, e.clientY);
    }

    resolveFilePathWithCallback(filePath, (resolvedPath) => {
      if (!mountedRef.current || currentHoverPathRef.current !== filePath) {
        return;
      }

      const safeResolvedPath = getSafeFallbackText(resolvedPath ?? undefined);
      if (!safeResolvedPath) {
        resolvedTextCacheRef.current.delete(filePath);
        if (fallback) {
          currentTooltipTextRef.current = fallback;
          const { clientX, clientY } = latestMousePositionRef.current;
          tooltip.showTooltip(fallback, clientX, clientY);
        } else {
          currentTooltipTextRef.current = undefined;
          tooltip.hideTooltip();
        }
        return;
      }

      resolvedTextCacheRef.current.set(filePath, safeResolvedPath);
      currentTooltipTextRef.current = safeResolvedPath;
      const { clientX, clientY } = latestMousePositionRef.current;
      tooltip.showTooltip(safeResolvedPath, clientX, clientY);
    });
  }, [fallbackText, filePath, tooltip]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    latestMousePositionRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (!currentTooltipTextRef.current) {
      return;
    }
    tooltip.moveTooltip(currentTooltipTextRef.current, e.clientX, e.clientY);
  }, [tooltip]);

  const onMouseLeave = useCallback(() => {
    currentHoverPathRef.current = undefined;
    currentTooltipTextRef.current = undefined;
    tooltip.hideTooltip();
  }, [tooltip]);

  return { onMouseEnter, onMouseMove, onMouseLeave };
}
