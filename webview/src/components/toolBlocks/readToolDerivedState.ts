import type { TFunction } from 'i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { extractToolResultImages, type ToolResultImage } from '../../utils/toolResultImages';
import { getToolLineInfo, type ToolTargetInfo } from '../../utils/toolPresentation';

export interface ReadToolDerivedState {
  isCompleted: boolean;
  isError: boolean;
  lineInfo: { start?: number; end?: number };
  actionText: string;
  params: [string, unknown][];
  resultImages: ToolResultImage[];
}

/**
 * Derives all render-time state for ReadToolBlock from its props.
 * Pure extraction of the previous inline computation — no behavior change.
 */
export const deriveReadToolState = (
  input: ToolInput,
  target: ToolTargetInfo | undefined,
  isDirectory: boolean,
  result: ToolResultBlock | null | undefined,
  isDenied: boolean,
  t: TFunction,
): ReadToolDerivedState => {
  // Determine tool call status based on result.
  // While the model is still waiting on the read result, the indicator must
  // reflect "pending" (yellow breathing) instead of misleading green "completed".
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  const isError = isDenied || (isCompleted && result?.is_error === true);

  const lineInfo = getToolLineInfo(input, target);
  const actionText = isDirectory ? t('permission.tools.readDirectory') : t('permission.tools.Read');

  // Get all input parameters for the expanded view, excluding Codex-specific fields
  const params = Object.entries(input).filter(([key]) =>
    key !== 'file_path' &&
    key !== 'target_file' &&
    key !== 'path' &&
    key !== 'command' &&    // Omit Codex command field
    key !== 'workdir' &&    // Omit Codex workdir field
    key !== 'description'   // Omit Codex description field
  );

  // Nested image blocks in the tool_result (Read of an image file)
  const resultImages = extractToolResultImages(result);

  return { isCompleted, isError, lineInfo, actionText, params, resultImages };
};
