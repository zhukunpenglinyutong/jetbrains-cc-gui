import type { TFunction } from 'i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
import { isCommandToolName, parseCommandType } from '../../utils/toolCommandPath';
import {
  getToolLineInfo,
  resolveToolTarget,
  type ToolTargetInfo,
} from '../../utils/toolPresentation';
import { extractToolResultImages } from '../../utils/toolResultImages';
import {
  extractPatchFiles,
  getOtherParams,
  getToolCodicon,
  getToolDisplayName,
  resolveToolSummary,
} from './genericToolMeta';

interface UseGenericToolStateArgs {
  t: TFunction;
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
}

// Codex uses 'cmd', others use 'command'
const resolveCommandStr = (input?: ToolInput): string | undefined => {
  if (!input) return undefined;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return undefined;
};

interface FileLinkState {
  effectiveIsFile: boolean;
  filePath: string | undefined;
  tooltipPath: string;
}

const resolveFileLinkState = (
  lowerName: string,
  target: ToolTargetInfo | undefined,
  commandStr: string | undefined,
): FileLinkState => {
  const filePath = target?.rawPath;
  const isFilePath = target?.isFile ?? false;
  // For command-executing tools with read type, treat as file if we have a path
  const isCommandRead = isCommandToolName(lowerName) && !!commandStr && parseCommandType(commandStr).type === 'read';
  const effectiveIsFile = isFilePath || isCommandRead;
  const tooltipPath = target?.displayPath ?? filePath ?? '';
  return { effectiveIsFile, filePath, tooltipPath };
};

interface StatusFlags {
  isCompleted: boolean;
  isError: boolean;
}

const resolveStatusFlags = (
  result: ToolResultBlock | null | undefined,
  isDenied: boolean,
  lowerName: string,
): StatusFlags => {
  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // AskUserQuestion tool should never show as error - it's a user interaction tool
  // The is_error field may be set by SDK but it doesn't indicate a real error
  const isAskUserQuestion = lowerName === 'askuserquestion';
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true && !isAskUserQuestion);
  return { isCompleted, isError };
};

const resolveFileIconSvg = (target: ToolTargetInfo | undefined): string => {
  if (!target) return '';
  if (target.isDirectory) {
    return getFolderIcon(target.cleanFileName);
  }
  const extension = target.cleanFileName.includes('.') ? target.cleanFileName.split('.').pop() : '';
  return getFileIcon(extension ?? '', target.cleanFileName);
};

/**
 * Derived state for GenericToolBlock. Everything feeding
 * useResolvedFileLinkTooltip is computed with null guards so hooks run
 * unconditionally; the component keeps its early returns below the hook call.
 */
export function useGenericToolState({ t, name, input, result, toolId }: UseGenericToolStateArgs) {
  const isDenied = useIsToolDenied(toolId);

  const lowerName = (name ?? '').toLowerCase();
  const target = input ? resolveToolTarget(input, name) : undefined;
  const commandStr = resolveCommandStr(input);
  const { effectiveIsFile, filePath, tooltipPath } = resolveFileLinkState(lowerName, target, commandStr);
  const fileLinkTooltip = useResolvedFileLinkTooltip(
    effectiveIsFile ? filePath : undefined,
    tooltipPath || undefined,
  );

  const { isCompleted, isError } = resolveStatusFlags(result, isDenied, lowerName);

  const displayName = getToolDisplayName(t, name, input);
  const codicon = getToolCodicon(name, input);
  const summary = input ? resolveToolSummary(input, target, commandStr) : null;
  const otherParams = input ? getOtherParams(input) : [];
  // Extract all file paths for apply_patch tool
  const patchFiles = input ? extractPatchFiles(lowerName, input) : [];

  // Nested image blocks in the tool_result (Read of image files, screenshots)
  const resultImages = extractToolResultImages(result);

  const hasExpandableContent = otherParams.length > 0 || resultImages.length > 0;
  const isDirectoryPath = target?.isDirectory ?? false;
  const lineInfo = input && target ? getToolLineInfo(input, target) : {};
  const fileIconSvg = resolveFileIconSvg(target);

  return {
    lowerName,
    target,
    isCompleted,
    isError,
    displayName,
    codicon,
    summary,
    otherParams,
    patchFiles,
    resultImages,
    hasExpandableContent,
    isDirectoryPath,
    lineInfo,
    fileIconSvg,
    effectiveIsFile,
    fileLinkTooltip,
  };
}
