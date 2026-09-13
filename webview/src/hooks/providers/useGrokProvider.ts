import { GROK_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * Grok CLI provider state (MVP).
 * Auth/config comes from ~/.grok. Default `-m` is profile name `grok`.
 */
export function useGrokProvider() {
  const state = useCliProviderState(GROK_DEFAULT_MODEL_ID);
  return {
    selectedGrokModel: state.selectedModel,
    setSelectedGrokModel: state.setSelectedModel,
    grokPermissionMode: state.permissionMode,
    setGrokPermissionMode: state.setPermissionMode,
  };
}

export type UseGrokProviderReturn = ReturnType<typeof useGrokProvider>;
