/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Unique identifier */
  id: string;
  /** Agent name (max 20 characters) */
  name: string;
  /** Prompt (max 100000 characters) */
  prompt?: string;
  /** Creation timestamp */
  createdAt?: number;
}

/**
 * Agent operation result
 */
export interface AgentOperationResult {
  success: boolean;
  operation: 'add' | 'update' | 'delete';
  error?: string;
}
