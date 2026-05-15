import type { EditOperation, FileChangeSummary } from '../types';

const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'create_file']);

const normalizeToolName = (toolName?: string): string => (toolName || '').trim().toLowerCase();

export const getFileChangeStatusFromOperations = (operations: EditOperation[] = []): 'A' | 'M' => {
  if (operations.length === 0) {
    return 'M';
  }
  const firstOperation = operations[0];
  if (firstOperation.existedBefore === false) {
    return 'A';
  }
  if (firstOperation.existedBefore === true) {
    return 'M';
  }
  return WRITE_TOOL_NAMES.has(normalizeToolName(firstOperation.toolName)) ? 'A' : 'M';
};

export const getProcessedOperationKey = (filePath: string, operation: EditOperation): string => {
  if (operation.operationId) {
    return `op:${operation.operationId}`;
  }
  if (operation.toolUseId) {
    return `tool:${operation.toolUseId}`;
  }
  if (operation.occurrenceId) {
    return `occ:${operation.occurrenceId}`;
  }
  return [
    `fp:${filePath}`,
    operation.toolName,
    operation.oldString,
    operation.newString,
    operation.lineStart ?? '',
    operation.lineEnd ?? '',
  ].join('\u0000');
};

export const getProcessedOperationKeys = (filePath: string, operations: EditOperation[] = []): string[] =>
  operations.map((operation) => getProcessedOperationKey(filePath, operation));

export const filterProcessedFileChanges = (
  fileChanges: FileChangeSummary[],
  processedOperationKeys: string[]
): FileChangeSummary[] => {
  if (processedOperationKeys.length === 0) {
    return fileChanges;
  }
  const processed = new Set(processedOperationKeys);
  return fileChanges
    .map((fileChange) => {
      const operations = fileChange.operations.filter(
        (operation) => !processed.has(getProcessedOperationKey(fileChange.filePath, operation))
      );
      if (operations.length === fileChange.operations.length) {
        return fileChange;
      }
      if (operations.length === 0) {
        return null;
      }
      const additions = operations.reduce((sum, operation) => sum + (operation.additions || 0), 0);
      const deletions = operations.reduce((sum, operation) => sum + (operation.deletions || 0), 0);
      const firstLineOperation = operations.find((operation) => typeof operation.lineStart === 'number');
      return {
        ...fileChange,
        status: getFileChangeStatusFromOperations(operations),
        additions,
        deletions,
        lineStart: firstLineOperation?.lineStart,
        lineEnd: firstLineOperation?.lineEnd,
        operations,
      };
    })
    .filter((fileChange): fileChange is FileChangeSummary => fileChange !== null);
};
