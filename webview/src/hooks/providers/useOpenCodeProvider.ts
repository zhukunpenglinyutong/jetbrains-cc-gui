import { useState } from 'react';
import {
  OPENCODE_DEFAULT_MODEL_ID,
  type PermissionMode,
} from '../../components/ChatInputBox/types';

/**
 * opencode-specific selectable state. The real LLM provider and model are
 * user-managed by opencode, so the UI only tracks the bridge placeholder model
 * and the permission mode to send with each prompt.
 */
export function useOpenCodeProvider() {
  const [selectedOpenCodeModel, setSelectedOpenCodeModel] = useState(OPENCODE_DEFAULT_MODEL_ID);
  const [openCodePermissionMode, setOpenCodePermissionMode] = useState<PermissionMode>('default');

  return {
    selectedOpenCodeModel,
    setSelectedOpenCodeModel,
    openCodePermissionMode,
    setOpenCodePermissionMode,
  };
}

export type UseOpenCodeProviderReturn = ReturnType<typeof useOpenCodeProvider>;
