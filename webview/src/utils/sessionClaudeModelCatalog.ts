import type { ModelInfo } from '../components/ChatInputBox/types';
import { updateClaudeModelCapabilities } from './claudeModelCapabilities';

export interface SessionClaudeModelCatalog {
  models: ModelInfo[];
  defaultModel: string | null;
  replaceBuiltInOptions: boolean;
}

let catalog: SessionClaudeModelCatalog | null = null;
const listeners = new Set<() => void>();

/** The conversation catalog never replaces the global auxiliary-feature catalog. */
export function setSessionClaudeModelCatalog(value: SessionClaudeModelCatalog | null): void {
  catalog = value;
  updateClaudeModelCapabilities(value?.models ?? []);
  for (const listener of listeners) listener();
}

export function getSessionClaudeModelCatalog(): SessionClaudeModelCatalog | null {
  return catalog;
}

export function subscribeSessionClaudeModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
