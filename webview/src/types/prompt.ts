/**
 * Prompt library configuration
 */
export interface PromptConfig {
  /** Unique identifier */
  id: string;
  /** Prompt name (max 30 characters) */
  name: string;
  /** Prompt content (max 100000 characters) */
  content: string;
  /** Creation timestamp */
  createdAt?: number;
  /** Last updated timestamp */
  updatedAt?: number;
}

/**
 * Prompt operation result
 */
export interface PromptOperationResult {
  success: boolean;
  operation: 'add' | 'update' | 'delete';
  error?: string;
}
