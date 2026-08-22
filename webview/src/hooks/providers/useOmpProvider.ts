import { OMP_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * OMP CLI provider state.
 * Auth/config comes from OMP CLI native home (~/.omp).
 */
export function useOmpProvider() {
  const state = useCliProviderState(OMP_DEFAULT_MODEL_ID);
  return {
    selectedOmpModel: state.selectedModel,
    setSelectedOmpModel: state.setSelectedModel,
    ompPermissionMode: state.permissionMode,
    setOmpPermissionMode: state.setPermissionMode,
  };
}

export type UseOmpProviderReturn = ReturnType<typeof useOmpProvider>;
