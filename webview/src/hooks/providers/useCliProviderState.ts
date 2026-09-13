import { useState } from 'react';
import type { PermissionMode } from '../../components/ChatInputBox/types';

/**
 * Shared local model + permission state for headless CLI providers
 * (Grok / Kimi / OpenCode). Auth stays with each CLI's native config.
 */
export function useCliProviderState(defaultModelId: string) {
  const [selectedModel, setSelectedModel] = useState(defaultModelId);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  return {
    selectedModel,
    setSelectedModel,
    permissionMode,
    setPermissionMode,
  };
}

export type UseCliProviderStateReturn = ReturnType<typeof useCliProviderState>;
