import type { ConflictStrategy } from './import';

/**
 * Prompt scope type - determines where prompts are stored
 */
export type PromptScope = 'global' | 'project';

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
  /** Scope of the prompt (for display purposes) */
  scope?: PromptScope;
}

// ============================================================================
// Message Types for Backend Communication
// ============================================================================

/**
 * Message data for getting prompts
 */
export interface GetPromptsMessage {
  scope: PromptScope;
}

/**
 * Message data for adding a prompt
 */
export interface AddPromptMessage {
  scope: PromptScope;
  prompt: Omit<PromptConfig, 'scope'>;
}

/**
 * Message data for updating a prompt
 */
export interface UpdatePromptMessage {
  scope: PromptScope;
  id: string;
  updates: Partial<Omit<PromptConfig, 'id' | 'scope'>>;
}

/**
 * Message data for deleting a prompt
 */
export interface DeletePromptMessage {
  scope: PromptScope;
  id: string;
}

/**
 * Message data for exporting prompts
 */
export interface ExportPromptsMessage {
  scope: PromptScope;
  promptIds: string[];
}

/**
 * Message data for importing prompts from file
 */
export interface ImportPromptsFileMessage {
  scope: PromptScope;
}

/**
 * Message data for saving imported prompts
 */
export interface SaveImportedPromptsMessage {
  scope: PromptScope;
  prompts: PromptConfig[];
  strategy: ConflictStrategy;
}

/**
 * Project information
 */
export interface ProjectInfo {
  /** Project name */
  name?: string;
  /** Project path */
  path?: string;
  /** Whether project scope is available */
  available: boolean;
}
