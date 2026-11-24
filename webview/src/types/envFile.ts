/**
 * Env file configuration — wire contract with the Java side.
 *
 * The backend (`ProjectConfigHandler.buildEnvFileStatePayload`) answers
 * `window.updateEnvFile` with:
 *
 * ```json
 * {
 *   "envFile": "<path>",        // "" when disabled, ".env" when not configured
 *   "envFileState": "configured" | "notConfigured" | "disabled",
 *   "envFileDisabled": true | false
 * }
 * ```
 *
 * and accepts three inbound shapes on `set_env_file`:
 *
 * ```json
 * {"envFile": "/abs/path/.env"}  // configure a path
 * {"envFile": ""}                // explicit opt-out: load nothing, no auto-discovery
 * {"reset": true}                // back to auto-discovery of <project>/.env
 * ```
 *
 * Only the path is ever sent to the webview — never the values inside the file.
 */

/** The three backend states, plus a neutral "we could not tell" bucket. */
export type EnvFileState =
  | 'configured'
  | 'notConfigured'
  | 'disabled'
  | 'unknown';

/** Why a client-side path was rejected before being sent. */
export type EnvFilePathIssue = 'invalidCharacters' | 'parentTraversal' | 'tooLong';

/** Result of normalizing a user-typed env file path on the webview side. */
export type EnvFilePathValidation =
  | { ok: true; value: string }
  | { ok: false; issue: EnvFilePathIssue };

/** Normalized view of one `window.updateEnvFile` payload. */
export interface EnvFileUpdate {
  envFile: string;
  state: EnvFileState;
}

/** Longest path we are willing to echo back to the backend. */
const MAX_ENV_FILE_PATH_LENGTH = 4096;

const BACKEND_STATES: ReadonlySet<string> = new Set<EnvFileState>([
  'configured',
  'notConfigured',
  'disabled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow an untrusted `envFileState` field to a known backend state.
 *
 * Fail-closed by design: an absent, mistyped or future value becomes
 * {@link EnvFileState} `'unknown'` rather than a default like `'configured'`,
 * so a malformed backend response can never make the UI claim that a file is
 * loaded when nothing says so. Contradictory payloads (e.g. a state of
 * `configured` next to `envFileDisabled: true`) are downgraded the same way.
 */
export function parseEnvFileState(
  rawState: unknown,
  rawDisabled?: unknown,
): EnvFileState {
  if (typeof rawState === 'string' && BACKEND_STATES.has(rawState)) {
    const state = rawState as EnvFileState;
    if (state === 'disabled' && rawDisabled === false) {
      return 'unknown';
    }
    if (state !== 'disabled' && rawDisabled === true) {
      return 'unknown';
    }
    return state;
  }
  return 'unknown';
}

/**
 * Parse the `window.updateEnvFile` payload. Never throws: a broken payload
 * degrades to an empty field with the neutral `'unknown'` state, which is what
 * the UI needs in order to stop showing a stale "configured" answer.
 */
export function parseEnvFileUpdate(json: string): EnvFileUpdate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { envFile: '', state: 'unknown' };
  }
  if (!isRecord(parsed)) {
    return { envFile: '', state: 'unknown' };
  }
  return {
    envFile: typeof parsed.envFile === 'string' ? parsed.envFile : '',
    state: parseEnvFileState(parsed.envFileState, parsed.envFileDisabled),
  };
}

/**
 * Client-side normalization of a user-typed env file path — defense in depth
 * behind the Java validation (which is the one that actually checks that the
 * file exists and normalizes it to an absolute path).
 *
 * An empty value is *not* an error: it is the explicit opt-out, a third state
 * the backend models with its own sentinel.
 */
export function normalizeEnvFilePath(raw: string): EnvFilePathValidation {
  const value = (raw ?? '').trim();
  if (value === '') {
    return { ok: true, value: '' };
  }
  if (value.length > MAX_ENV_FILE_PATH_LENGTH) {
    return { ok: false, issue: 'tooLong' };
  }
  // NUL, newlines and other control characters have no place in a path and
  // truncate strings in several native layers downstream.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, issue: 'invalidCharacters' };
  }
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) {
    return { ok: false, issue: 'parentTraversal' };
  }
  return { ok: true, value };
}
