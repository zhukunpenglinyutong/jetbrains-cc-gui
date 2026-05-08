import { useCallback, useState } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import { CODEX_MODELS } from '../../components/ChatInputBox/types';
import type { PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';

/**
 * Codex-specific selectable state. `reasoningEffort` lives here because the
 * value set is a Codex/OpenAI concept (low/medium/high/xhigh/max). The change
 * handler forwards directly to the backend via bridge event.
 */
export function useCodexProvider() {
  const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
  const [codexPermissionMode, setCodexPermissionMode] = useState<PermissionMode>('default');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('high');

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, []);

  return {
    selectedCodexModel,
    setSelectedCodexModel,
    codexPermissionMode,
    setCodexPermissionMode,
    reasoningEffort,
    setReasoningEffort,
    handleReasoningChange,
  };
}

export type UseCodexProviderReturn = ReturnType<typeof useCodexProvider>;
