import { useCallback, useEffect, useState } from 'react';
import {
  OMP_APPROVAL_DEFAULT,
  OMP_DEFAULT_MODEL_ID,
  isValidOmpApprovalMode,
  type OmpApprovalMode,
} from '../../components/ChatInputBox/types';
import { sendBridgeEvent } from '../../utils/bridge';
import { useCliProviderState } from './useCliProviderState';

/**
 * OMP CLI provider state.
 * Auth/config comes from OMP CLI native home (~/.omp).
 *
 * The approval mode belongs to the tab and Java keeps it: every change is
 * reported, and a (re)loaded page gets the tab's choice back. A page that
 * forgot it would start at "Default", which leaves approvals to OMP's own
 * setting: full auto unless the user changed it.
 */
export function useOmpProvider() {
  const state = useCliProviderState(OMP_DEFAULT_MODEL_ID);
  const [ompApprovalMode, setOmpApprovalMode] = useState<OmpApprovalMode>(OMP_APPROVAL_DEFAULT);

  useEffect(() => {
    // The value comes from Java, so it is not reported back.
    const restore = (mode: string) => {
      setOmpApprovalMode(isValidOmpApprovalMode(mode) ? mode : OMP_APPROVAL_DEFAULT);
    };
    const pending = window.__pendingOmpApprovalMode;
    delete window.__pendingOmpApprovalMode;
    if (pending !== undefined) restore(pending);
    window.onOmpApprovalModeReceived = restore;
    return () => {
      if (window.onOmpApprovalModeReceived === restore) delete window.onOmpApprovalModeReceived;
    };
  }, []);

  const handleOmpApprovalModeChange = useCallback((mode: OmpApprovalMode) => {
    if (!isValidOmpApprovalMode(mode)) return;
    setOmpApprovalMode(mode);
    sendBridgeEvent('set_omp_approval_mode', mode);
  }, []);

  return {
    selectedOmpModel: state.selectedModel,
    setSelectedOmpModel: state.setSelectedModel,
    ompPermissionMode: state.permissionMode,
    setOmpPermissionMode: state.setPermissionMode,
    ompApprovalMode,
    handleOmpApprovalModeChange,
  };
}

export type UseOmpProviderReturn = ReturnType<typeof useOmpProvider>;
