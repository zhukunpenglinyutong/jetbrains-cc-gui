/**
 * Type definitions for batch import functionality
 */

/**
 * Conflict resolution strategy when importing items with duplicate IDs
 */
export type ConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

/**
 * Preview item containing data and conflict status
 */
export interface ImportPreviewItem<T> {
  /** The actual data to be imported */
  data: T;
  /** Status indicating if this is a new item or an update to existing */
  status: 'new' | 'update';
  /** Whether this item conflicts with an existing item */
  conflict: boolean;
}

/**
 * Preview result returned from backend after validating import file
 */
export interface ImportPreviewResult<T> {
  /** Array of items to be imported with their status */
  items: ImportPreviewItem<T>[];
  /** Summary statistics about the import */
  summary: {
    /** Total number of items in the import */
    total: number;
    /** Number of new items (no conflicts) */
    newCount: number;
    /** Number of items that will update existing ones */
    updateCount: number;
  };
}

/**
 * Result returned after completing the import operation
 */
export interface ImportResult {
  /** Whether the import operation succeeded */
  success: boolean;
  /** Number of new items imported */
  imported: number;
  /** Number of items skipped due to conflicts or validation errors */
  skipped: number;
  /** Number of existing items updated */
  updated: number;
  /** List of error messages if any occurred */
  errors?: string[];
  /** Error message if the operation failed */
  error?: string;
}
