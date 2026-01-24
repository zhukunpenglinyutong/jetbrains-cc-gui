/**
 * File changes types for StatusPanel
 */

/** File change status: A = Added (new file), M = Modified */
export type FileChangeStatus = 'A' | 'M';

/** Single edit operation record */
export interface EditOperation {
  toolName: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  replaceAll?: boolean;
}

/** Aggregated file change summary */
export interface FileChangeSummary {
  filePath: string;
  fileName: string;
  status: FileChangeStatus;
  /** Total additions (sum of all operations) */
  additions: number;
  /** Total deletions (sum of all operations) */
  deletions: number;
  /** All edit operations for this file (for showMultiEditDiff) */
  operations: EditOperation[];
}
