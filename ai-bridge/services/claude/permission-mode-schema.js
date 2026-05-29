/**
 * Minimal runtime validator mirroring the subset of @anthropic-ai/claude-agent-sdk
 * hook return shapes that createPreToolUseHook actually produces.
 *
 * The SDK does NOT export its internal Zod schema, so we maintain a mirror here.
 * Keep in sync with sdk.d.ts on SDK upgrades. The pieces this validator covers:
 *
 *   - HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer' (sdk.d.ts:763)
 *   - PreToolUseHookSpecificOutput (sdk.d.ts:1999)
 *   - SyncHookJSONOutput (sdk.d.ts:5527)
 *   - AsyncHookJSONOutput (sdk.d.ts:118)
 *
 * Why this exists: PR #1121 → #1126 → #1213 all introduced or carried the
 * invalid value `permissionDecision: 'continue'` because tests only asserted
 * "what the hook returned" instead of "would the SDK accept what the hook
 * returned." This validator gives tests a way to assert the latter.
 */

const HOOK_PERMISSION_DECISION = new Set(['allow', 'deny', 'ask', 'defer']);
const SYNC_DECISION = new Set(['approve', 'block']);

const SYNC_TOP_LEVEL_KEYS = new Set([
  'continue',
  'suppressOutput',
  'stopReason',
  'decision',
  'systemMessage',
  'reason',
  'hookSpecificOutput',
]);

const ASYNC_TOP_LEVEL_KEYS = new Set(['async', 'asyncTimeout']);

const PRE_TOOL_USE_KEYS = new Set([
  'hookEventName',
  'permissionDecision',
  'permissionDecisionReason',
  'updatedInput',
  'additionalContext',
]);

function fail(path, message) {
  return { ok: false, error: `${path}: ${message}` };
}

function validatePreToolUseHookSpecificOutput(value, path) {
  if (value === null || typeof value !== 'object') {
    return fail(path, `expected object, got ${value === null ? 'null' : typeof value}`);
  }
  if (value.hookEventName !== 'PreToolUse') {
    return fail(`${path}.hookEventName`, `expected literal 'PreToolUse', got ${JSON.stringify(value.hookEventName)}`);
  }
  if (value.permissionDecision !== undefined && !HOOK_PERMISSION_DECISION.has(value.permissionDecision)) {
    return fail(
      `${path}.permissionDecision`,
      `expected one of ${[...HOOK_PERMISSION_DECISION].map(v => `'${v}'`).join('|')}, got ${JSON.stringify(value.permissionDecision)}`
    );
  }
  if (value.permissionDecisionReason !== undefined && typeof value.permissionDecisionReason !== 'string') {
    return fail(`${path}.permissionDecisionReason`, 'expected string');
  }
  if (value.updatedInput !== undefined && (value.updatedInput === null || typeof value.updatedInput !== 'object')) {
    return fail(`${path}.updatedInput`, 'expected object');
  }
  if (value.additionalContext !== undefined && typeof value.additionalContext !== 'string') {
    return fail(`${path}.additionalContext`, 'expected string');
  }
  for (const key of Object.keys(value)) {
    if (!PRE_TOOL_USE_KEYS.has(key)) {
      return fail(`${path}.${key}`, 'unknown key (would be rejected by SDK Zod schema)');
    }
  }
  return { ok: true };
}

/**
 * Validate a value as one of: SyncHookJSONOutput | AsyncHookJSONOutput | undefined.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * The createPreToolUseHook contract allows returning undefined (SDK treats it as
 * "continue with defaults"), an empty object, or any of the documented shapes.
 */
export function validateHookOutput(output) {
  if (output === undefined || output === null) return { ok: true };
  if (typeof output !== 'object') {
    return fail('<root>', `expected object, got ${typeof output}`);
  }

  if (output.async === true) {
    if (output.asyncTimeout !== undefined && typeof output.asyncTimeout !== 'number') {
      return fail('asyncTimeout', 'expected number');
    }
    for (const key of Object.keys(output)) {
      if (!ASYNC_TOP_LEVEL_KEYS.has(key)) {
        return fail(key, 'unknown key on AsyncHookJSONOutput');
      }
    }
    return { ok: true };
  }

  if (output.continue !== undefined && typeof output.continue !== 'boolean') {
    return fail('continue', 'expected boolean');
  }
  if (output.suppressOutput !== undefined && typeof output.suppressOutput !== 'boolean') {
    return fail('suppressOutput', 'expected boolean');
  }
  if (output.stopReason !== undefined && typeof output.stopReason !== 'string') {
    return fail('stopReason', 'expected string');
  }
  if (output.decision !== undefined && !SYNC_DECISION.has(output.decision)) {
    return fail('decision', `expected 'approve'|'block', got ${JSON.stringify(output.decision)}`);
  }
  if (output.systemMessage !== undefined && typeof output.systemMessage !== 'string') {
    return fail('systemMessage', 'expected string');
  }
  if (output.reason !== undefined && typeof output.reason !== 'string') {
    return fail('reason', 'expected string');
  }
  if (output.hookSpecificOutput !== undefined) {
    const r = validatePreToolUseHookSpecificOutput(output.hookSpecificOutput, 'hookSpecificOutput');
    if (!r.ok) return r;
  }
  for (const key of Object.keys(output)) {
    if (!SYNC_TOP_LEVEL_KEYS.has(key)) {
      return fail(key, 'unknown key on SyncHookJSONOutput');
    }
  }
  return { ok: true };
}

/**
 * Helper for tests: throws an AssertionError-shaped Error if the hook output
 * would be rejected by the SDK. Use after every hook invocation in tests.
 */
export function assertSdkAcceptsHookOutput(output) {
  const r = validateHookOutput(output);
  if (!r.ok) {
    throw new Error(`SDK would reject hook output (${r.error}). Got: ${JSON.stringify(output)}`);
  }
}
