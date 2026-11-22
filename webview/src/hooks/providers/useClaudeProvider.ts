import { useCallback, useState } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import { DEFAULT_CLAUDE_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';

/**
 * Claude-specific selectable state and native Ultracode toggle. Handlers that span providers
 * (mode/model/provider switching, long-context toggle) live in the orchestrator
 * (useModelProviderState) since they need to read both Claude and Codex state.
 */
export function useClaudeProvider() {
  const [selectedClaudeModel, setSelectedClaudeModel] = useState(DEFAULT_CLAUDE_MODEL_ID);
  const [claudePermissionMode, setClaudePermissionMode] = useState<PermissionMode>('default');
  const [longContextEnabled, setLongContextEnabled] = useState(true);
  const [claudeSettingsAlwaysThinkingEnabled, setClaudeSettingsAlwaysThinkingEnabled] = useState(true);

  const [claudeUltracode, setClaudeUltracode] = useState(false);
  const handleClaudeUltracodeChange = useCallback((enabled: boolean) => {
    setClaudeUltracode(enabled);
    sendBridgeEvent('set_claude_ultracode', String(enabled));
  }, []);

  return {
    claudeUltracode,
    setClaudeUltracode,
    handleClaudeUltracodeChange,
    selectedClaudeModel,
    setSelectedClaudeModel,
    claudePermissionMode,
    setClaudePermissionMode,
    longContextEnabled,
    setLongContextEnabled,
    claudeSettingsAlwaysThinkingEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  };
}

export type UseClaudeProviderReturn = ReturnType<typeof useClaudeProvider>;
