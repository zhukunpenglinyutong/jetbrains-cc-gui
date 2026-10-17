/**
 * Codex sandbox selection resolution (design D7).
 *
 * Reads the RAW persisted `codexSandboxMode` fields with presence detection —
 * never a getter that blends in platform defaults — so an unsaved Windows
 * value never becomes "explicit full access" evidence.
 *
 * Resolution order:
 *   current-user → legacy-project → legacy-default → native-config → safe-default
 *
 * Migration read-only protection: an explicit read-only from any effective
 * source is surfaced as `explicitReadOnly` so automatic migration (task 11.1)
 * and preset mapping can never widen it; only the user changing the access
 * scope control afterwards overrides it.
 *
 * This module performs no I/O: native effective configuration must be read by
 * an authorized caller and passed in. An inactive runtime therefore never
 * starts a child just to resolve a sandbox candidate.
 */

export const CODEX_SANDBOX_MODES = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export const CODEX_SANDBOX_SOURCES = Object.freeze([
  'current-user',
  'legacy-project',
  'legacy-default',
  'native-config',
  'safe-default',
]);

const SAFE_DEFAULT_SANDBOX = 'workspace-write';

function isKnownMode(value) {
  return typeof value === 'string' && CODEX_SANDBOX_MODES.includes(value);
}

function rawValue(rawSandboxConfig, key) {
  if (!rawSandboxConfig || typeof rawSandboxConfig !== 'object') {
    return { present: false, value: null };
  }
  // Presence check on the raw JSON — NOT a defaulted getter.
  if (!Object.prototype.hasOwnProperty.call(rawSandboxConfig, key)) {
    return { present: false, value: null };
  }
  const value = rawSandboxConfig[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { present: true, value: value === null ? null : String(value).trim() };
  }
  return { present: true, value: value.trim() };
}

/**
 * Resolve the sandbox access candidate.
 *
 * @param {object} opts
 * @param {object|null} [opts.rawSandboxConfig] raw `codexSandboxMode` JSON object
 * @param {string|null} [opts.projectPath] effective project/cwd key
 * @param {string|null} [opts.currentUserSelection] explicit UI access-scope choice
 * @param {object|null} [opts.nativeEffective] authorized native effective policy,
 *        `{ sandbox, policy? }` where sandbox is a known mode string and policy
 *        is already in the `turn/start.sandboxPolicy` wire format (camelCase
 *        fields per the v2 schema — e.g. networkAccess/writableRoots)
 * @returns {{
 *   status: 'resolved'|'migration-error',
 *   sandbox: string|null,
 *   sandboxPolicy: object|null,
 *   source: string|null,
 *   explicitReadOnly: boolean,
 *   explicitFullAccess: boolean,
 *   migrationError: string|null
 * }}
 */
export function resolveCodexSandboxCandidate({
  rawSandboxConfig = null,
  projectPath = null,
  currentUserSelection = null,
  nativeEffective = null,
} = {}) {
  const result = {
    status: 'resolved',
    sandbox: null,
    sandboxPolicy: null,
    source: null,
    explicitReadOnly: false,
    explicitFullAccess: false,
    migrationError: null,
  };

  // 0. An explicit current-user selection made after migration wins.
  if (currentUserSelection !== null && currentUserSelection !== undefined
      && String(currentUserSelection).trim() !== '') {
    const selection = String(currentUserSelection).trim();
    if (!isKnownMode(selection)) {
      result.status = 'migration-error';
      result.migrationError = `unknown sandbox selection: ${selection}`;
      return result;
    }
    result.sandbox = selection;
    result.source = 'current-user';
    result.explicitReadOnly = selection === 'read-only';
    result.explicitFullAccess = selection === 'danger-full-access';
    return result;
  }

  // 1./2. Raw project value, then raw default value. Presence, not defaults.
  const candidates = [];
  if (projectPath !== null && projectPath !== undefined && String(projectPath).trim() !== '') {
    candidates.push({ key: String(projectPath).trim(), source: 'legacy-project' });
  }
  candidates.push({ key: 'default', source: 'legacy-default' });

  for (const candidate of candidates) {
    const raw = rawValue(rawSandboxConfig, candidate.key);
    if (!raw.present) {
      continue;
    }
    if (!isKnownMode(raw.value)) {
      result.status = 'migration-error';
      result.migrationError = `unknown persisted sandbox value for ${candidate.key}: ${raw.value}`;
      return result;
    }
    result.sandbox = raw.value;
    result.source = candidate.source;
    result.explicitReadOnly = raw.value === 'read-only';
    result.explicitFullAccess = raw.value === 'danger-full-access';
    return result;
  }

  // 3. Native effective configuration, when an authorized caller provided it.
  if (nativeEffective && typeof nativeEffective === 'object') {
    const mode = nativeEffective.sandbox;
    if (mode !== null && mode !== undefined && !isKnownMode(mode)) {
      result.status = 'migration-error';
      result.migrationError = `unknown native sandbox mode: ${mode}`;
      return result;
    }
    if (isKnownMode(mode)) {
      result.sandbox = mode;
      result.source = 'native-config';
      result.sandboxPolicy = typeof nativeEffective.policy === 'object' && nativeEffective.policy !== null
        ? nativeEffective.policy
        : null;
      result.explicitReadOnly = mode === 'read-only';
      result.explicitFullAccess = mode === 'danger-full-access';
      return result;
    }
  }

  // 4. Cross-platform safe default. An unsaved Windows getter value is NOT
  // evidence of explicit full access, so it never reaches here.
  result.sandbox = SAFE_DEFAULT_SANDBOX;
  result.source = 'safe-default';
  return result;
}
