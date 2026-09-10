import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { refreshFile } from '../../utils/bridge';
import {
  getToolEditCount,
  getToolLineInfo,
  resolveToolTarget,
} from '../../utils/toolPresentation';
import { normalizeToolInput } from '../../utils/toolInputNormalization';
import { computeDiff } from './EditDiffView';
import type { EditToolItem } from './EditToolBlock';

/** First string value among the candidates, or undefined. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function resolveEditTarget(
  normalizedInput: EditToolItem['input'],
  name: string | undefined,
) {
  if (!normalizedInput) return undefined;
  return resolveToolTarget(
    {
      ...normalizedInput,
      file_path: firstString(normalizedInput.file_path, normalizedInput.filePath),
      target_file: firstString(normalizedInput.target_file, normalizedInput.targetFile),
    },
    name,
  );
}

/**
 * Derived state for EditToolBlock. Every hook lives here so the component
 * body only routes between the single-item diff view and the grouped view;
 * the hook call order is fixed for any item count, which lets React reuse
 * the component instance (and this state) across the 1 -> N transition
 * instead of unmounting EditToolBlock.
 */
export function useEditToolState(items: EditToolItem[]) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('diffExpandedByDefault') === 'true';
    } catch {
      return false;
    }
  });

  // The inline-diff view serves the single-item case; with multiple items the
  // component delegates to EditToolGroupBlock. That delegation return sits
  // after every hook, so read items[0] up front to keep the hook order
  // identical for any item count.
  const firstItem = items[0];
  const name = firstItem?.name;
  const input = firstItem?.input;
  const result = firstItem?.result;
  const toolId = firstItem?.toolId;

  const isDenied = useIsToolDenied(toolId);

  const normalizedInput = input ? normalizeToolInput(name, input) : input;

  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true);

  const target = resolveEditTarget(normalizedInput, name);
  const filePath = target?.openPath;

  const oldString = firstString(normalizedInput?.old_string, normalizedInput?.oldString) ?? '';
  const newString = firstString(normalizedInput?.new_string, normalizedInput?.newString) ?? '';

  const diff = useMemo(() => {
    // When delegating to the grouped view (items.length > 1) the diff is never
    // rendered, so skip the O(m*n) LCS pass for the first item - the early
    // return in the component hands off to EditToolGroupBlock before this
    // result is used.
    if (items.length !== 1) {
      return { lines: [], additions: 0, deletions: 0 };
    }
    const oldLines = oldString ? oldString.split('\n') : [];
    const newLines = newString ? newString.split('\n') : [];
    return computeDiff(oldLines, newLines);
  }, [items.length, oldString, newString]);

  // Auto-refresh file in IDEA when the tool call completes successfully
  const hasRefreshed = useRef(false);
  useEffect(() => {
    // Only the single-item view refreshes here; the grouped view runs its own
    // refresh effect, so skip when delegating to avoid duplicate refreshes.
    if (items.length !== 1) return;
    if (filePath && isCompleted && !isError && !hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshFile(filePath);
    }
  }, [items.length, filePath, isCompleted, isError]);

  const lineInfo = normalizedInput && target ? getToolLineInfo(normalizedInput, target, result) : {};
  const editCount = normalizedInput ? getToolEditCount(normalizedInput) : 0;
  const extraEditCount = editCount > 1 ? editCount - 1 : 0;

  return {
    expanded,
    setExpanded,
    name,
    result,
    toolId,
    normalizedInput,
    target,
    filePath,
    oldString,
    newString,
    diff,
    isCompleted,
    isError,
    lineInfo,
    extraEditCount,
  };
}
