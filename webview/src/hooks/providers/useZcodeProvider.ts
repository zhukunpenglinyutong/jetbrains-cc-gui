import { ZCODE_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/** ZCode provider slice exposed through useModelProviderState. */
export interface UseZcodeProviderReturn {
  selectedZcodeModel: string;
  setSelectedZcodeModel: (modelId: string) => void;
  zcodePermissionMode: PermissionMode;
  setZcodePermissionMode: (mode: PermissionMode) => void;
}

/**
 * ZCode provider state.
 * Auth/config comes from the ZCode desktop app (~/.zcode), driven through its
 * bundled app-server — the marker stream is identical to the Grok CLI shape.
 */
export function useZcodeProvider(): UseZcodeProviderReturn {
  const state = useCliProviderState(ZCODE_DEFAULT_MODEL_ID);
  return {
    selectedZcodeModel: state.selectedModel,
    setSelectedZcodeModel: state.setSelectedModel,
    zcodePermissionMode: state.permissionMode,
    setZcodePermissionMode: state.setPermissionMode,
  };
}
