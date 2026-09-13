import { KIMI_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * Kimi CLI provider state (MVP).
 * Auth/config comes from Kimi CLI native home.
 */
export function useKimiProvider() {
  const state = useCliProviderState(KIMI_DEFAULT_MODEL_ID);
  return {
    selectedKimiModel: state.selectedModel,
    setSelectedKimiModel: state.setSelectedModel,
    kimiPermissionMode: state.permissionMode,
    setKimiPermissionMode: state.setPermissionMode,
  };
}

export type UseKimiProviderReturn = ReturnType<typeof useKimiProvider>;
