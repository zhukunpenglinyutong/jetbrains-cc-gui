import { sendBridgeEvent } from './utils/bridge';
import { ompModeForModelId } from './hooks/providers/cliProviders';
import type { ModelInfo, PermissionMode } from './components/ChatInputBox/types';
import type { ChatScreenProps } from './components/ChatScreen';
import {
  apply1MContextSuffix,
  isValidPermissionMode,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from './components/ChatInputBox/types';

/** Signature expected by useSessionManagement (UseSessionManagementOptions). */
export type ApplyHistoryModel = (provider: string, model: string, agent?: string | null) => void;

/** Subset of useModelProviderState's return consumed by the factory. */
export interface ApplyHistoryModelDeps {
  currentProvider: string;
  longContextEnabled: boolean;
  handleProviderSelect: (providerId: string) => void;
  handleAgentSelect: ChatScreenProps['onAgentSelect'];
  setSelectedClaudeModel: (model: string) => void;
  setSelectedCodexModel: (model: string) => void;
  setSelectedGrokModel: (model: string) => void;
  setSelectedKimiModel: (model: string) => void;
  setSelectedMiniMaxModel: (model: string) => void;
  setSelectedOpenCodeModel: (model: string) => void;
  setSelectedPiModel: (model: string) => void;
  setSelectedDshModel: (model: string) => void;
  setSelectedGeminiModel: (model: string) => void;
  setSelectedOmpModel: (model: string) => void;
  setOmpPermissionMode: (mode: PermissionMode) => void;
}

interface CreateApplyHistoryModelOptions {
  modelState: ApplyHistoryModelDeps;
  ompRoles: ModelInfo[];
}

/**
 * Builds the applyHistoryModel callback passed to useSessionManagement.
 * Extracted verbatim from App.tsx: switch provider first when the history row
 * differs, then apply the model with a direct bridge event + setter because
 * handleModelSelect reads currentProvider from a stale closure right after a
 * provider switch.
 */
export const createApplyHistoryModel = ({
  modelState,
  ompRoles,
}: CreateApplyHistoryModelOptions): ApplyHistoryModel => {
  const {
    currentProvider,
    longContextEnabled,
    handleProviderSelect,
    handleAgentSelect,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedMiniMaxModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedDshModel,
    setSelectedGeminiModel,
    setSelectedOmpModel,
    setOmpPermissionMode,
  } = modelState;

  return (provider, model, agent) => {
    // Switch provider first when history row differs, then apply model.
    if (provider && provider !== currentProvider) {
      handleProviderSelect(provider);
    }
    if (model) {
      // handleModelSelect reads currentProvider; after provider switch state
      // may not have flushed yet — send bridge + setter for the target provider.
      if (provider === 'codex') {
        setSelectedCodexModel(model);
        sendBridgeEvent('set_model', model);
      } else if (provider === 'grok') {
        setSelectedGrokModel(model);
        sendBridgeEvent('set_model', model);
      } else if (provider === 'kimi') {
        setSelectedKimiModel(model);
        sendBridgeEvent('set_model', model);
      } else if (provider === 'minimax') {
        setSelectedMiniMaxModel(model);
        sendBridgeEvent('set_model', model);
      } else if (provider === 'opencode') {
        setSelectedOpenCodeModel(model);
        sendBridgeEvent('set_model', model);
      } else if (provider === 'pi') {
        setSelectedPiModel(model);
        sendBridgeEvent('set_model', model);
      } else if (provider === 'omp') {
        setSelectedOmpModel(model);
        sendBridgeEvent('set_model', model);
        const ompMode = ompModeForModelId(model, ompRoles);
        setOmpPermissionMode(ompMode);
        // Dynamic roles are not in Java's static mode whitelist — set_model
        // above already carries the role; skip set_mode for them.
        if (isValidPermissionMode(ompMode)) {
          sendBridgeEvent('set_mode', ompMode);
        }
      } else if (provider === 'dsh') {
        setSelectedDshModel(model);
        sendBridgeEvent('set_model', model);
      } else if (provider === 'gemini') {
        // Gemini model ids are full catalog slugs (family+effort is ONE slug):
        // they pass through UNCHANGED — no claude normalization, no [1m]
        // handling. A slug absent from the live CLI model list is auto-corrected
        // by ButtonArea's vanished-selection effect, not here.
        setSelectedGeminiModel(model);
        sendBridgeEvent('set_model', model);
      } else {
        // claude (or unrecognized): apply the claude model directly —
        // handleModelSelect reads currentProvider from a stale closure
        // right after a provider switch.
        const normalized = normalizeClaudeModelId(strip1MContextSuffix(model));
        setSelectedClaudeModel(normalized);
        sendBridgeEvent('set_model', apply1MContextSuffix(normalized, longContextEnabled));
      }
    }
    if (agent && provider === 'claude') {
      handleAgentSelect({ id: agent, name: agent, prompt: '' });
    }
  };
};
