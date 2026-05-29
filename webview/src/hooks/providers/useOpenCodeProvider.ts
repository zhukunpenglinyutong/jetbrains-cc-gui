import { useCallback, useState } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  OPENCODE_DEFAULT_MODEL_ID,
  type PermissionMode,
} from '../../components/ChatInputBox/types';

/**
 * opencode-specific selectable state. The real LLM provider and model are
 * user-managed by opencode, so the UI only tracks the bridge placeholder model,
 * the permission mode to send with each prompt, and the optional model variant
 * (thinking effort) when the selected model supports it.
 */
export function useOpenCodeProvider() {
  const [selectedOpenCodeModel, setSelectedOpenCodeModel] = useState(OPENCODE_DEFAULT_MODEL_ID);
  const [openCodePermissionMode, setOpenCodePermissionMode] = useState<PermissionMode>('default');
  const [openCodeModelVariant, setOpenCodeModelVariant] = useState<string | undefined>(undefined);

  const handleOpenCodeVariantChange = useCallback((variant: string) => {
    const normalized = variant === 'default' ? undefined : variant;
    setOpenCodeModelVariant(normalized);
    sendBridgeEvent('set_reasoning_effort', normalized ?? '');
  }, []);

  return {
    selectedOpenCodeModel,
    setSelectedOpenCodeModel,
    openCodePermissionMode,
    setOpenCodePermissionMode,
    openCodeModelVariant,
    setOpenCodeModelVariant,
    handleOpenCodeVariantChange,
  };
}

export type UseOpenCodeProviderReturn = ReturnType<typeof useOpenCodeProvider>;
