import type { EditOperation } from '../../types';

export interface BridgeEditOperation {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  lineStart?: number;
  lineEnd?: number;
  operationId?: string;
  source?: string;
  scopeId?: string;
  agentHandle?: string;
  parentToolUseId?: string;
  safeToRollback?: boolean;
  expectedAfterContentHash?: string;
  editSequence?: number;
  existedBefore?: boolean;
  toolUseId?: string;
}

export interface UndoAllResult {
  success?: boolean;
  partial?: boolean;
  succeededFiles?: string[];
  failedFiles?: Array<{ filePath?: string; reason?: string; message?: string }>;
  error?: string;
}

export const toBridgeOperations = (operations: EditOperation[]): BridgeEditOperation[] =>
  operations.map((op) => ({
    oldString: op.oldString,
    newString: op.newString,
    replaceAll: op.replaceAll,
    lineStart: op.lineStart,
    lineEnd: op.lineEnd,
    operationId: op.operationId,
    source: op.source,
    scopeId: op.scopeId,
    agentHandle: op.agentHandle,
    parentToolUseId: op.parentToolUseId,
    safeToRollback: op.safeToRollback,
    expectedAfterContentHash: op.expectedAfterContentHash,
    editSequence: op.editSequence,
    existedBefore: op.existedBefore,
    toolUseId: op.toolUseId,
  }));

export { filterProcessedFileChanges, getProcessedOperationKey, getProcessedOperationKeys } from '../../utils/fileChangeProcessing';

export const getSucceededFilesFromUndoAllResult = (result: UndoAllResult): string[] => {
  if (!Array.isArray(result.succeededFiles)) {
    return [];
  }
  return result.succeededFiles.filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0);
};

export const getUndoAllFailureMessage = (result: UndoAllResult, fallback: string): string => {
  if (typeof result.error === 'string' && result.error.length > 0) {
    return result.error;
  }
  if (Array.isArray(result.failedFiles) && result.failedFiles.length > 0) {
    return result.failedFiles
      .map((failure) => {
        const filePath = failure.filePath || 'unknown';
        const reason = failure.message || failure.reason || 'Unknown error';
        return `${filePath}: ${reason}`;
      })
      .join('; ');
  }
  return fallback;
};

export const getFilesToDiscardAfterUndoAll = (result: UndoAllResult, requestedFiles: string[]): string[] => {
  const succeededFiles = getSucceededFilesFromUndoAllResult(result);
  if (succeededFiles.length > 0) {
    return succeededFiles;
  }
  if (result.success) {
    return requestedFiles.filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0);
  }
  return [];
};
