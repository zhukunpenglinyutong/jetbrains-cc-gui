import { useEffect } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  OPENCODE_DEFAULT_MODEL_ID,
  isValidPermissionMode,
  normalizeClaudeModelId,
  apply1MContextSuffix,
  strip1MContextSuffix,
} from '../../components/ChatInputBox/types';
import type { PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import type { AgentsByProvider } from './useProviderSettings';

const STORAGE_KEY = 'model-selection-state';
const AGENTS_STORAGE_KEY = 'agents-by-provider-state';
const REASONING_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const getCustomModels = (key: string): { id: string }[] => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_VALUES as readonly string[]).includes(value);

export interface UseModelStatePersistenceOptions {
  // Cross-slice load setters (run once on mount)
  setCurrentProvider: (value: string) => void;
  setSelectedClaudeModel: (value: string) => void;
  setSelectedCodexModel: (value: string) => void;
  setSelectedOpenCodeModel: (value: string) => void;
  setClaudePermissionMode: (value: PermissionMode) => void;
  setCodexPermissionMode: (value: PermissionMode) => void;
  setOpenCodePermissionMode: (value: PermissionMode) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setLongContextEnabled: (value: boolean) => void;
  setReasoningEffort: (value: ReasoningEffort) => void;
  setOpenCodeModelVariant: (value: string | undefined) => void;
  setAgentsByProvider: (value: React.SetStateAction<AgentsByProvider>) => void;
  // Cross-slice save deps (re-saves on any change)
  currentProvider: string;
  selectedClaudeModel: string;
  selectedCodexModel: string;
  selectedOpenCodeModel: string;
  claudePermissionMode: PermissionMode;
  codexPermissionMode: PermissionMode;
  openCodePermissionMode: PermissionMode;
  longContextEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  openCodeModelVariant?: string;
  agentsByProvider: AgentsByProvider;
}

/**
 * Two effects for persisting cross-slice provider/model state to localStorage:
 *  1. On mount: hydrate state from localStorage and sync the restored values
 *     to the backend (retrying until the JCEF bridge is ready).
 *  2. On change: re-save the snapshot to localStorage.
 *
 * Save uses a single JSON snapshot of provider state; load applies
 * defensive validation (custom models lookup, permission mode allowlist,
 * reasoning effort allowlist) before invoking the slice setters.
 */
export function useModelStatePersistence(options: UseModelStatePersistenceOptions) {
  const {
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedOpenCodeModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setOpenCodePermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setOpenCodeModelVariant,
    setAgentsByProvider,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    selectedOpenCodeModel,
    claudePermissionMode,
    codexPermissionMode,
    openCodePermissionMode,
    longContextEnabled,
    reasoningEffort,
    openCodeModelVariant,
    agentsByProvider,
  } = options;

  // Hydrate from localStorage and sync to backend (mount only).
  // Setters are stable; deps left empty to ensure single execution.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      let restoredProvider = 'claude';
      let restoredClaudeModel = CLAUDE_MODELS[0].id;
      let restoredCodexModel = CODEX_MODELS[0].id;
      let restoredOpenCodeModel = OPENCODE_DEFAULT_MODEL_ID;
      let restoredClaudePermissionMode: PermissionMode = 'bypassPermissions';
      let restoredCodexPermissionMode: PermissionMode = 'default';
      let restoredOpenCodePermissionMode: PermissionMode = 'default';
      let restoredLongContextEnabled = true;
      let restoredOpenCodeModelVariant: string | undefined;
      let restoredReasoningEffort: ReasoningEffort | undefined;

      if (saved) {
        const state = JSON.parse(saved);

        if (['claude', 'codex', 'opencode'].includes(state.provider)) {
          restoredProvider = state.provider;
          setCurrentProvider(state.provider);
        }

        if (isValidPermissionMode(state.claudePermissionMode)) {
          restoredClaudePermissionMode = state.claudePermissionMode;
        }
        if (isValidPermissionMode(state.codexPermissionMode)) {
          restoredCodexPermissionMode = state.codexPermissionMode === 'plan'
            ? 'default'
            : state.codexPermissionMode;
        }
        if (isValidPermissionMode(state.openCodePermissionMode)) {
          restoredOpenCodePermissionMode = state.openCodePermissionMode;
        }

        if (typeof state.longContextEnabled === 'boolean') {
          restoredLongContextEnabled = state.longContextEnabled;
          setLongContextEnabled(state.longContextEnabled);
        }

        if (isReasoningEffort(state.reasoningEffort)) {
          restoredReasoningEffort = state.reasoningEffort;
          setReasoningEffort(state.reasoningEffort);
        }

        const savedClaudeCustomModels = getCustomModels('claude-custom-models');
        const strippedClaudeModel = strip1MContextSuffix(state.claudeModel);
        const normalizedClaudeModel = normalizeClaudeModelId(strippedClaudeModel);
        if (
          CLAUDE_MODELS.find(m => m.id === normalizedClaudeModel) ||
          savedClaudeCustomModels.find(m => m.id === normalizedClaudeModel)
        ) {
          restoredClaudeModel = normalizedClaudeModel;
          setSelectedClaudeModel(normalizedClaudeModel);
        }

        const savedCodexCustomModels = getCustomModels('codex-custom-models');
        if (
          CODEX_MODELS.find(m => m.id === state.codexModel) ||
          savedCodexCustomModels.find(m => m.id === state.codexModel)
        ) {
          restoredCodexModel = state.codexModel;
          setSelectedCodexModel(state.codexModel);
        }

        if (typeof state.openCodeModel === 'string' && state.openCodeModel.trim().length > 0) {
          restoredOpenCodeModel = state.openCodeModel.trim();
          setSelectedOpenCodeModel(restoredOpenCodeModel);
        }

        if (typeof state.openCodeModelVariant === 'string' && state.openCodeModelVariant.trim().length > 0) {
          restoredOpenCodeModelVariant = state.openCodeModelVariant.trim();
          setOpenCodeModelVariant(restoredOpenCodeModelVariant);
        }
      }

      const initialPermissionMode: PermissionMode = restoredProvider === 'codex'
        ? restoredCodexPermissionMode
        : restoredProvider === 'opencode'
          ? restoredOpenCodePermissionMode
          : restoredClaudePermissionMode;
      setClaudePermissionMode(restoredClaudePermissionMode);
      setCodexPermissionMode(restoredCodexPermissionMode);
      setOpenCodePermissionMode(restoredOpenCodePermissionMode);
      setPermissionMode(initialPermissionMode);

      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30;

      const syncToBackend = () => {
        if (window.sendToJava) {
          sendBridgeEvent('set_provider', restoredProvider);
          const modelToSync = restoredProvider === 'codex'
            ? restoredCodexModel
            : restoredProvider === 'opencode'
              ? restoredOpenCodeModel
              : apply1MContextSuffix(restoredClaudeModel, restoredLongContextEnabled);
          sendBridgeEvent('set_model', modelToSync);
          sendBridgeEvent('set_mode', initialPermissionMode);
          if (restoredProvider === 'opencode') {
            sendBridgeEvent('set_reasoning_effort', restoredOpenCodeModelVariant ?? '');
          } else if (restoredProvider === 'codex' && restoredReasoningEffort) {
            sendBridgeEvent('set_reasoning_effort', restoredReasoningEffort);
          }
        } else {
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          }
        }
      };
      setTimeout(syncToBackend, 200);

      // Hydrate agent selections per provider from localStorage
      try {
        const savedAgents = localStorage.getItem(AGENTS_STORAGE_KEY);
        if (savedAgents) {
          const parsed = JSON.parse(savedAgents);
          if (parsed && typeof parsed === 'object') {
            setAgentsByProvider(parsed);
          }
        }
      } catch {
        // Failed to restore agent selections — non-fatal.
      }
    } catch {
      // Failed to load model selection state — fall back to defaults already
      // set by individual slice hooks.
    }
  }, []);

  // Persist snapshot whenever any of the seven keys change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        provider: currentProvider,
        claudeModel: selectedClaudeModel,
        codexModel: selectedCodexModel,
        openCodeModel: selectedOpenCodeModel,
        claudePermissionMode,
        codexPermissionMode,
        openCodePermissionMode,
        longContextEnabled,
        reasoningEffort,
        openCodeModelVariant,
      }));
    } catch {
      // Failed to save model selection state — non-fatal.
    }
  }, [
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    selectedOpenCodeModel,
    claudePermissionMode,
    codexPermissionMode,
    openCodePermissionMode,
    longContextEnabled,
    reasoningEffort,
    openCodeModelVariant,
  ]);

  // Persist agent selections per provider whenever the map changes.
  useEffect(() => {
    try {
      localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(agentsByProvider));
    } catch {
      // Failed to save agent selections — non-fatal.
    }
  }, [agentsByProvider]);
}
