import { useState } from 'react';
import { OMP_APPROVAL_DEFAULT, OMP_DEFAULT_MODEL_ID, type OmpApprovalMode } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * OMP CLI provider state.
 * Auth/config comes from OMP CLI native home (~/.omp).
 */
export function useOmpProvider() {
  const state = useCliProviderState(OMP_DEFAULT_MODEL_ID);
  const [ompApprovalMode, setOmpApprovalMode] = useState<OmpApprovalMode>(OMP_APPROVAL_DEFAULT);
  return {
    selectedOmpModel: state.selectedModel,
    setSelectedOmpModel: state.setSelectedModel,
    ompPermissionMode: state.permissionMode,
    setOmpPermissionMode: state.setPermissionMode,
    ompApprovalMode,
    setOmpApprovalMode,
  };
}

export type UseOmpProviderReturn = ReturnType<typeof useOmpProvider>;
