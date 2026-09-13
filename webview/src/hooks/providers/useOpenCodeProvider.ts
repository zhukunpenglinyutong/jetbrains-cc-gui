import { OPENCODE_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * OpenCode CLI provider state (MVP).
 * Auth/config comes from OpenCode native config.
 */
export function useOpenCodeProvider() {
  const state = useCliProviderState(OPENCODE_DEFAULT_MODEL_ID);
  return {
    selectedOpenCodeModel: state.selectedModel,
    setSelectedOpenCodeModel: state.setSelectedModel,
    openCodePermissionMode: state.permissionMode,
    setOpenCodePermissionMode: state.setPermissionMode,
  };
}

export type UseOpenCodeProviderReturn = ReturnType<typeof useOpenCodeProvider>;
