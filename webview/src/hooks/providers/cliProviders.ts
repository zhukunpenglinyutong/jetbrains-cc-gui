import type { ModelInfo, PermissionMode } from '../../components/ChatInputBox/types';

/** Headless CLI providers that share Grok-style marker streaming (no npm SDK). */
export const CLI_ONLY_PROVIDERS = new Set(['grok', 'kimi', 'opencode', 'pi', 'omp', 'dsh', 'gemini', 'minimax']);

export function isCliOnlyProvider(providerId: string | null | undefined): boolean {
  return !!providerId && CLI_ONLY_PROVIDERS.has(providerId);
}

/**
 * Static OMP model roles — used only to reconcile snapshots persisted before
 * roles became dynamic. The live role list comes from useOmpRoles() (dynamic
 * listModels roles, falling back to these same three when unloaded).
 */
export const OMP_ROLE_MODEL_IDS: ReadonlySet<string> = new Set(['smol', 'slow', 'plan']);

/**
 * Maps an omp model id to its mode: an id present in `roles` maps to the
 * same-named mode, everything else ('auto' or any catalog model) maps to
 * 'default'. Pass useOmpRoles() — it already falls back to the static
 * smol/slow/plan entries when no dynamic roles have loaded.
 */
export function ompModeForModelId(modelId: string, roles: ModelInfo[]): PermissionMode {
  return roles.some((role) => role.id === modelId) ? modelId : 'default';
}

/**
 * The postures the gemini CLI natively supports (its ModeSelect set).
 * Anything else in the gemini slot — e.g. omp-only role ids from a stale or
 * corrupted snapshot — is coerced to default on every normalize pass, so the
 * displayed mode can never diverge from the mode the next turn sends.
 */
const GEMINI_MODE_IDS: ReadonlySet<string> = new Set([
  'default', 'plan', 'acceptEdits', 'bypassPermissions', 'sandbox',
]);

/**
 * Plan mode and provider-native auto review are not exposed for headless CLI
 * providers, so they are coerced to default. The legacy autoEdit alias is
 * migrated to acceptEdits (or default for OMP), while OMP preserves model-role
 * ids (default / smol / slow / plan). Gemini is the other exception: the CLI
 * natively supports plan/read-only (`agy --mode plan`).
 *
 * `sandbox` is a gemini-only posture: it passes through for gemini (one of
 * GEMINI_MODE_IDS) and is coerced to default for every other provider — omp
 * included (a "sandbox" there could only come from a corrupted snapshot, never
 * from the role list). The gemini branch additionally filters to its five
 * native postures, so omp-only role ids cannot restore into the gemini slot.
 */
export function normalizeCliPermissionMode(mode: PermissionMode, provider?: string | null): PermissionMode {
  if (provider === 'omp') {
    return mode === 'auto' || mode === 'autoEdit' || mode === 'sandbox' ? 'default' : mode;
  }
  if (provider === 'gemini') {
    return GEMINI_MODE_IDS.has(mode) ? mode : 'default';
  }
  if (mode === 'autoEdit') {
    return 'acceptEdits';
  }
  return mode === 'plan' || mode === 'auto' || mode === 'sandbox' ? 'default' : mode;
}
