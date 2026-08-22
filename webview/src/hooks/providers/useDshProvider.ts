import { useState } from 'react';
import { DSH_DEFAULT_MODEL_ID, DSH_PRESET_NONE } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * DSH (DeepSeek Harness) provider state.
 * Auth/config lives in the DSH host ($DSH_HOME via the DSH Web UI); the plugin
 * only stores the last-picked `provider/model` id locally.
 */
export function useDshProvider() {
  const state = useCliProviderState(DSH_DEFAULT_MODEL_ID);
  const [dshPreset, setDshPreset] = useState(DSH_PRESET_NONE);
  return {
    selectedDshModel: state.selectedModel,
    setSelectedDshModel: state.setSelectedModel,
    dshPermissionMode: state.permissionMode,
    setDshPermissionMode: state.setPermissionMode,
    dshPreset,
    setDshPreset,
  };
}

export type UseDshProviderReturn = ReturnType<typeof useDshProvider>;
