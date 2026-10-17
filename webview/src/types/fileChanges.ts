/**
 * File changes types for StatusPanel
 */

/** Session changes include additions, modifications, deletions and renames. */
export type FileChangeStatus = 'A' | 'M' | 'D' | 'R';

/** Single edit operation record */
export interface EditOperation {
  toolUseId?: string;
  ledgerKey?: string;
  oldStringKnown?: boolean;
  fileChangeKind?: 'add' | 'update' | 'delete';
  moveFrom?: string;
  patch?: string;
  toolName: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  replaceAll?: boolean;
  lineStart?: number;
  lineEnd?: number;
}

/** Aggregated file change summary */
export interface FileChangeSummary {
  filePath: string;
  fileName: string;
  status: FileChangeStatus;
  /**
   * Net additions for the session: diff(baseline, current), not sum of ops.
   */
  additions: number;
  /**
   * Net deletions for the session: diff(baseline, current), not sum of ops.
   */
  deletions: number;
  /** True when ≥2 agents in this session touched the file */
  multiAgent?: boolean;
  /** Distinct agent ids that edited this file (main + subagents) */
  agentIds?: string[];
  /** First reliable line range for file-level navigation */
  lineStart?: number;
  lineEnd?: number;
  /** All edit operations for this file (for showMultiEditDiff / undo) */
  operations: EditOperation[];
}
