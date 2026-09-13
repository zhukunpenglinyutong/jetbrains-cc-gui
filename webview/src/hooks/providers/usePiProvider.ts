import { PI_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * PI CLI provider state.
 * Auth/config comes from PI CLI native home (~/.pi).
 */
export function usePiProvider() {
  const state = useCliProviderState(PI_DEFAULT_MODEL_ID);
  return {
    selectedPiModel: state.selectedModel,
    setSelectedPiModel: state.setSelectedModel,
    piPermissionMode: state.permissionMode,
    setPiPermissionMode: state.setPermissionMode,
  };
}

export type UsePiProviderReturn = ReturnType<typeof usePiProvider>;
