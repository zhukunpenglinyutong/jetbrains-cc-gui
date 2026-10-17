import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  isValidPermissionMode,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from '../components/ChatInputBox/types';
import type { ModelInfo, PermissionMode } from '../components/ChatInputBox/types';
import type { ProviderConfig } from '../types/provider';
import { readCustomClaudeModelIds } from '../utils/customClaudeModels';
import { normalizeCliPermissionMode, ompModeForModelId } from './providers/cliProviders';

/**
 * Module-level pure helpers for useModelProviderState. Each function carries
 * one provider-branch decision so the orchestrator hook stays flat; behavior
 * is byte-identical to the inline branches they replace.
 */

/** Per-provider selected-model snapshot, keyed by provider id. */
export interface ProviderModelSelection {
  claude: string;
  codex: string;
  grok: string;
  kimi: string;
  minimax: string;
  zcode: string;
  opencode: string;
  pi: string;
  omp: string;
  dsh: string;
}

/** Per-provider permission-mode snapshot, keyed by provider id. */
export interface ProviderPermissionModes {
  claude: PermissionMode;
  codex: PermissionMode;
  grok: PermissionMode;
  kimi: PermissionMode;
  minimax: PermissionMode;
  zcode: PermissionMode;
  opencode: PermissionMode;
  pi: PermissionMode;
  omp: PermissionMode;
  dsh: PermissionMode;
}

/** Native Codex settings persisted independently from the legacy mode field. */
export type CodexCollaborationMode = 'default' | 'plan';
export type CodexApprovalPreset = 'request' | 'auto' | 'sandboxed-auto' | 'full-access';
export type CodexSandboxSelection = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexSandboxSource = 'native' | 'migrated' | 'user' | 'default';

export interface CodexSettingsSnapshot {
  collaborationMode: CodexCollaborationMode;
  approvalPreset: CodexApprovalPreset;
  sandboxSelection: CodexSandboxSelection;
  sandboxSource: CodexSandboxSource;
  migrationVersion: number;
}

const CODEX_APPROVAL_PRESETS: readonly CodexApprovalPreset[] = [
  'request', 'auto', 'sandboxed-auto', 'full-access',
];
const CODEX_SANDBOX_SELECTIONS: readonly CodexSandboxSelection[] = [
  'read-only', 'workspace-write', 'danger-full-access',
];

/**
 * Migrate one persisted Codex snapshot without widening access implicitly.
 * Legacy bypass/yolo values only become full-access when an explicit marker
 * proves the user selected that scope; otherwise they remain sandboxed-auto.
 */
export function migrateCodexSettingsSnapshot(raw: Record<string, unknown> | null | undefined): CodexSettingsSnapshot {
  const value = raw ?? {};
  const legacyMode = value.codexPermissionMode;
  const collaborationMode: CodexCollaborationMode = value.codexCollaborationMode === 'plan'
    || legacyMode === 'plan' ? 'plan' : 'default';

  const approvalPreset = CODEX_APPROVAL_PRESETS.includes(value.codexApprovalPreset as CodexApprovalPreset)
    ? value.codexApprovalPreset as CodexApprovalPreset
    : legacyMode === 'auto'
      ? 'auto'
      : legacyMode === 'bypassPermissions' || legacyMode === 'yolo'
        ? (value.codexFullAccessExplicit === true ? 'full-access' : 'sandboxed-auto')
        : 'request';

  const sandboxSelection = CODEX_SANDBOX_SELECTIONS.includes(
    value.codexSandboxSelection as CodexSandboxSelection,
  )
    ? value.codexSandboxSelection as CodexSandboxSelection
    : legacyMode === 'readOnly'
      ? 'read-only'
      : approvalPreset === 'full-access' && value.codexFullAccessExplicit === true
        ? 'danger-full-access'
        : 'workspace-write';

  const source: CodexSandboxSource = value.codexSandboxSource === 'native'
    || value.codexSandboxSource === 'migrated'
    || value.codexSandboxSource === 'user'
    || value.codexSandboxSource === 'default'
    ? value.codexSandboxSource
    : value.codexSandboxSelection ? 'migrated' : 'default';

  return {
    collaborationMode,
    approvalPreset,
    sandboxSelection,
    sandboxSource: source,
    migrationVersion: typeof value.codexSettingsMigrationVersion === 'number'
      && Number.isFinite(value.codexSettingsMigrationVersion)
      ? Math.max(1, Math.floor(value.codexSettingsMigrationVersion)) : 1,
  };
}

/** Model shown for the active provider; unknown ids fall back to Claude. */
export function selectedModelForProvider(providerId: string, models: ProviderModelSelection): string {
  switch (providerId) {
    case 'codex': return models.codex;
    case 'grok': return models.grok;
    case 'kimi': return models.kimi;
    case 'minimax': return models.minimax;
    case 'zcode': return models.zcode;
    case 'opencode': return models.opencode;
    case 'pi': return models.pi;
    case 'omp': return models.omp;
    case 'dsh': return models.dsh;
    default: return models.claude;
  }
}

/**
 * Mode to activate when switching to `providerId`: the provider's saved mode,
 * normalized through the CLI rules. Codex 'auto' is a native-runtime decision
 * and no longer depends on a TypeScript SDK version floor.
 */
export function resolveProviderPermissionMode(
  providerId: string,
  modes: ProviderPermissionModes,
): PermissionMode {
  switch (providerId) {
    case 'codex': {
      // Check for 'auto' BEFORE normalizeCliPermissionMode, which coerces
      // 'auto' → 'default' for every CLI provider — a saved 'auto' would be
      // silently demoted on every provider switch otherwise.
      if (modes.codex === 'auto') {
        return 'auto';
      }
      return normalizeCliPermissionMode(modes.codex, providerId);
    }
    case 'grok': return normalizeCliPermissionMode(modes.grok, providerId);
    case 'kimi': return normalizeCliPermissionMode(modes.kimi, providerId);
    case 'minimax': return normalizeCliPermissionMode(modes.minimax, providerId);
    case 'zcode': return normalizeCliPermissionMode(modes.zcode, providerId);
    case 'opencode': return normalizeCliPermissionMode(modes.opencode, providerId);
    case 'pi': return normalizeCliPermissionMode(modes.pi, providerId);
    case 'omp': return normalizeCliPermissionMode(modes.omp, providerId);
    case 'dsh': return normalizeCliPermissionMode(modes.dsh, providerId);
    default: return modes.claude;
  }
}

/**
 * Model to activate when switching to `providerId`. The Claude fallback keeps
 * the 1M-context suffix in sync with the long-context toggle.
 */
export function resolveProviderModel(
  providerId: string,
  models: ProviderModelSelection,
  longContextEnabled: boolean,
): string {
  switch (providerId) {
    case 'codex': return models.codex;
    case 'grok': return models.grok;
    case 'kimi': return models.kimi;
    case 'minimax': return models.minimax;
    case 'zcode': return models.zcode;
    case 'opencode': return models.opencode;
    case 'pi': return models.pi;
    case 'omp': return models.omp;
    case 'dsh': return models.dsh;
    default: return apply1MContextSuffix(models.claude, longContextEnabled);
  }
}

/** State setters and model setters consumed by applyCliModeSelect. */
export interface CliModeSelectActions {
  setPermissionMode: (mode: PermissionMode) => void;
  setGrokPermissionMode: (mode: PermissionMode) => void;
  setKimiPermissionMode: (mode: PermissionMode) => void;
  setMiniMaxPermissionMode: (mode: PermissionMode) => void;
  setZcodePermissionMode: (mode: PermissionMode) => void;
  setOpenCodePermissionMode: (mode: PermissionMode) => void;
  setPiPermissionMode: (mode: PermissionMode) => void;
  setOmpPermissionMode: (mode: PermissionMode) => void;
  setDshPermissionMode: (mode: PermissionMode) => void;
  setSelectedOmpModel: (modelId: string) => void;
}

/**
 * Applies a mode selection for a headless CLI provider: normalizes the mode,
 * mirrors it into the provider slice, and pushes it over the bridge. OMP is
 * special-cased: the mode selector is a shortcut over the model value, so it
 * also selects the same-named model and skips set_mode for dynamic roles.
 */
export function applyCliModeSelect(
  providerId: string,
  mode: PermissionMode,
  actions: CliModeSelectActions,
): void {
  const cliMode = normalizeCliPermissionMode(mode, providerId);
  actions.setPermissionMode(cliMode);
  switch (providerId) {
    case 'grok': actions.setGrokPermissionMode(cliMode); break;
    case 'kimi': actions.setKimiPermissionMode(cliMode); break;
    case 'minimax': actions.setMiniMaxPermissionMode(cliMode); break;
    case 'zcode': actions.setZcodePermissionMode(cliMode); break;
    case 'opencode': actions.setOpenCodePermissionMode(cliMode); break;
    case 'pi': actions.setPiPermissionMode(cliMode); break;
    case 'omp': {
      actions.setOmpPermissionMode(cliMode);
      // The omp mode selector is a shortcut over the model value: role modes
      // set the model to the role id, 'default' selects the CLI default.
      const ompModel = cliMode === 'default' ? 'auto' : cliMode;
      actions.setSelectedOmpModel(ompModel);
      sendBridgeEvent('set_model', ompModel);
      // Java's VALID_PERMISSION_MODES is a static whitelist — dynamic roles
      // (e.g. 'designer') would be rejected there; set_model carries them.
      if (isValidPermissionMode(cliMode)) {
        sendBridgeEvent('set_mode', cliMode);
      }
      return;
    }
    case 'dsh': actions.setDshPermissionMode(cliMode); break;
  }
  sendBridgeEvent('set_mode', cliMode);
}

/** Setters consumed by applyModelSelect. */
export interface ModelSelectActions {
  setSelectedClaudeModel: (modelId: string) => void;
  setSelectedCodexModel: (modelId: string) => void;
  setSelectedGrokModel: (modelId: string) => void;
  setSelectedKimiModel: (modelId: string) => void;
  setSelectedMiniMaxModel: (modelId: string) => void;
  setSelectedZcodeModel: (modelId: string) => void;
  setSelectedOpenCodeModel: (modelId: string) => void;
  setSelectedPiModel: (modelId: string) => void;
  setSelectedOmpModel: (modelId: string) => void;
  setSelectedDshModel: (modelId: string) => void;
  setOmpPermissionMode: (mode: PermissionMode) => void;
  setPermissionMode: (mode: PermissionMode) => void;
}

/**
 * Applies a model selection for the active provider. Claude normalizes the id
 * and reapplies the 1M-context suffix; OMP unifies mode⇔model via the dynamic
 * role list; every other provider stores and forwards the id verbatim.
 */
export function applyModelSelect(
  providerId: string,
  modelId: string,
  longContextEnabled: boolean,
  ompRoles: ModelInfo[],
  actions: ModelSelectActions,
): void {
  if (providerId === 'claude') {
    const strippedModelId = strip1MContextSuffix(modelId);
    // Explicit user pick: a custom model id is forwarded verbatim, never migrated.
    const normalizedModelId = normalizeClaudeModelId(strippedModelId, readCustomClaudeModelIds());
    actions.setSelectedClaudeModel(normalizedModelId);
    sendBridgeEvent('set_model', apply1MContextSuffix(normalizedModelId, longContextEnabled));
    return;
  }
  if (providerId === 'omp') {
    actions.setSelectedOmpModel(modelId);
    sendBridgeEvent('set_model', modelId);
    // Mode⇔model unification: role models select the same-named mode,
    // anything else ('auto' or catalog models) selects 'default'.
    const ompMode = ompModeForModelId(modelId, ompRoles);
    actions.setOmpPermissionMode(ompMode);
    actions.setPermissionMode(ompMode);
    // Dynamic roles are not in Java's static mode whitelist — set_model
    // above already carries the role; skip set_mode for them.
    if (isValidPermissionMode(ompMode)) {
      sendBridgeEvent('set_mode', ompMode);
    }
    return;
  }
  const simpleSetters: Record<string, ((id: string) => void) | undefined> = {
    codex: actions.setSelectedCodexModel,
    grok: actions.setSelectedGrokModel,
    kimi: actions.setSelectedKimiModel,
    minimax: actions.setSelectedMiniMaxModel,
    zcode: actions.setSelectedZcodeModel,
    opencode: actions.setSelectedOpenCodeModel,
    pi: actions.setSelectedPiModel,
    dsh: actions.setSelectedDshModel,
  };
  const setSelectedModel = simpleSetters[providerId];
  if (setSelectedModel) {
    setSelectedModel(modelId);
    sendBridgeEvent('set_model', modelId);
  }
}

/** State-updater for toggling always-thinking on the active provider config. */
export function withAlwaysThinkingEnabled(
  prev: ProviderConfig | null,
  enabled: boolean,
): ProviderConfig | null {
  return prev
    ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      }
    : prev;
}

/** Bridge payload for persisting the always-thinking toggle on a provider. */
export function buildThinkingUpdatePayload(config: ProviderConfig, enabled: boolean): string {
  return JSON.stringify({
    id: config.id,
    updates: {
      settingsConfig: {
        ...(config.settingsConfig || {}),
        alwaysThinkingEnabled: enabled,
      },
    },
  });
}
