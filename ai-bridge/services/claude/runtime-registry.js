const runtimesBySessionId = new Map();
const anonymousRuntimes = new Set();
const anonymousRuntimesBySignature = new Map();

let activeTurnRuntime = null;

// Backstop for a protection leak (a turn counter, in-flight flag or background
// task that is never cleared). A busy runtime is reclaimed only when it is older
// than RUNTIME_MAX_ABSOLUTE_LIFETIME_MS AND has produced no CLI message for
// RUNTIME_STUCK_SILENCE_MS. Age alone never interrupts work that is still
// streaming: every CLI message refreshes lastUsedAt (see touchRuntime).
const RUNTIME_MAX_ABSOLUTE_LIFETIME_MS = 6 * 60 * 60 * 1000;
const RUNTIME_STUCK_SILENCE_MS = 2 * 60 * 60 * 1000;
// Deliberately aggressive: an idle SDK subprocess is disposed after 60s and the
// next message lazily respawns it with --resume. Active turns, in-flight CLI
// output, and tracked background tasks are exempt (see getRuntimeDisposalReason).
const ANONYMOUS_RUNTIME_MAX_IDLE_MS = 60 * 1000;
const SESSION_RUNTIME_MAX_IDLE_MS = 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 15 * 1000;

export {
  RUNTIME_MAX_ABSOLUTE_LIFETIME_MS,
  RUNTIME_STUCK_SILENCE_MS,
  ANONYMOUS_RUNTIME_MAX_IDLE_MS,
  SESSION_RUNTIME_MAX_IDLE_MS,
  SESSION_CLEANUP_INTERVAL_MS
};

export function rememberRuntime(runtime, requestContext, registerActiveQueryResult) {
  if (requestContext.requestedSessionId) {
    runtimesBySessionId.set(requestContext.requestedSessionId, runtime);
    registerActiveQueryResult?.(requestContext.requestedSessionId, runtime.query);
    return;
  }

  anonymousRuntimes.add(runtime);
  anonymousRuntimesBySignature.set(requestContext.runtimeSignature, runtime);
}

export function promoteRuntimeToSession(runtime, sessionId, { removeSession, registerActiveQueryResult }) {
  if (!sessionId) return;

  console.log('[LIFECYCLE] registerRuntimeSession sessionId=' + sessionId
    + ' epoch=' + (runtime?.runtimeSessionEpoch || '(none)'));

  for (const [signature, item] of anonymousRuntimesBySignature.entries()) {
    if (item === runtime) {
      anonymousRuntimesBySignature.delete(signature);
    }
  }

  for (const [existingSessionId, existingRuntime] of runtimesBySessionId.entries()) {
    if (existingRuntime === runtime && existingSessionId !== sessionId) {
      runtimesBySessionId.delete(existingSessionId);
      removeSession?.(existingSessionId);
    }
  }

  runtime.sessionId = sessionId;
  runtime.runtimeSessionEpoch = runtime.runtimeSessionEpoch || null;
  runtimesBySessionId.set(sessionId, runtime);
  anonymousRuntimes.delete(runtime);
  registerActiveQueryResult?.(sessionId, runtime.query);
}

export function removeRuntime(runtime, removeSession) {
  anonymousRuntimes.delete(runtime);

  for (const [signature, item] of anonymousRuntimesBySignature.entries()) {
    if (item === runtime) {
      anonymousRuntimesBySignature.delete(signature);
    }
  }

  for (const [sessionId, item] of runtimesBySessionId.entries()) {
    if (item === runtime) {
      runtimesBySessionId.delete(sessionId);
      removeSession?.(sessionId);
    }
  }
}

export function findRuntimeForRequest(requestContext) {
  if (requestContext.requestedSessionId) {
    return runtimesBySessionId.get(requestContext.requestedSessionId) || null;
  }
  const exact = anonymousRuntimesBySignature.get(requestContext.runtimeSignature);
  if (exact) return exact;
  // A bypass transition changes the spawn-time signature before the next
  // request arrives. Only consider a pending runtime from the same anonymous
  // session epoch; otherwise a request could dispose another session's runtime.
  if (!requestContext.runtimeSessionEpoch) return null;
  for (const runtime of anonymousRuntimes) {
    if (runtime.runtimeSignature === '__rebuild-pending-bypass-change__'
        && runtime.runtimeSessionEpoch === requestContext.runtimeSessionEpoch) {
      return runtime;
    }
  }
  return null;
}

export function beginRuntimeTurn(runtime) {
  if (!runtime) return;
  runtime.activeTurnCount = (runtime.activeTurnCount || 0) + 1;
}

export function endRuntimeTurn(runtime) {
  if (!runtime) return;
  runtime.activeTurnCount = Math.max((runtime.activeTurnCount || 0) - 1, 0);
}

export function touchRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.lastUsedAt = Date.now();
}

function isRuntimeBusy(runtime) {
  return (runtime.activeTurnCount || 0) > 0
    || !!runtime.cliTurnInFlight
    || (runtime.backgroundTaskIds?.size || 0) > 0;
}

/**
 * Why the idle sweep may dispose this runtime: 'idle', 'stuck', or null to keep it.
 */
export function getRuntimeDisposalReason(runtime, now, maxIdleMs) {
  if (!runtime || runtime.closed) return null;
  const silentMs = now - runtime.lastUsedAt;
  if (isRuntimeBusy(runtime)) {
    const pastLifetime = now - runtime.createdAt > RUNTIME_MAX_ABSOLUTE_LIFETIME_MS;
    return pastLifetime && silentMs > RUNTIME_STUCK_SILENCE_MS ? 'stuck' : null;
  }
  return silentMs > maxIdleMs ? 'idle' : null;
}

export function canDisposeIdleRuntime(runtime, now, maxIdleMs) {
  return getRuntimeDisposalReason(runtime, now, maxIdleMs) !== null;
}

function describeDisposal(reason, runtime, now) {
  const silentSeconds = Math.round((now - runtime.lastUsedAt) / 1000);
  if (reason === 'stuck') {
    const ageSeconds = Math.round((now - runtime.createdAt) / 1000);
    return 'stuck: busy, silent ' + silentSeconds + 's, age ' + ageSeconds + 's';
  }
  return 'idle ' + silentSeconds + 's';
}

export async function cleanupStaleAnonymousRuntimes(disposeFn) {
  const now = Date.now();
  const snapshot = [...anonymousRuntimes];
  for (const runtime of snapshot) {
    if (runtime.closed) {
      anonymousRuntimes.delete(runtime);
      continue;
    }
    const reason = getRuntimeDisposalReason(runtime, now, ANONYMOUS_RUNTIME_MAX_IDLE_MS);
    if (reason) {
      console.log(`[DAEMON] Disposing stale anonymous runtime (${describeDisposal(reason, runtime, now)})`);
      await disposeFn(runtime);
    }
  }
}

export async function cleanupStaleSessionRuntimes(disposeFn) {
  const now = Date.now();
  for (const [sessionId, runtime] of runtimesBySessionId.entries()) {
    if (runtime.closed) {
      runtimesBySessionId.delete(sessionId);
      continue;
    }
    const reason = getRuntimeDisposalReason(runtime, now, SESSION_RUNTIME_MAX_IDLE_MS);
    if (reason) {
      console.log(`[DAEMON] Disposing stale session runtime ${sessionId} (${describeDisposal(reason, runtime, now)})`);
      await disposeFn(runtime);
    }
  }
}

export function setActiveTurnRuntime(runtime) {
  activeTurnRuntime = runtime || null;
}

export function getActiveTurnRuntime() {
  return activeTurnRuntime;
}

export function clearActiveTurnRuntime() {
  activeTurnRuntime = null;
}

export function clearActiveTurnRuntimeIf(runtime) {
  if (activeTurnRuntime === runtime) {
    activeTurnRuntime = null;
  }
}

export function getAllRuntimes() {
  return new Set([
    ...anonymousRuntimes,
    ...anonymousRuntimesBySignature.values(),
    ...runtimesBySessionId.values(),
    activeTurnRuntime
  ].filter(Boolean));
}

export function getRuntimeForSession(sessionId) {
  return runtimesBySessionId.get(sessionId) || null;
}

export function getSnapshot() {
  return {
    anonymousRuntimeCount: anonymousRuntimes.size,
    sessionRuntimeCount: runtimesBySessionId.size,
    activeTurnEpoch: activeTurnRuntime?.runtimeSessionEpoch || null
  };
}

export function resetRegistryState() {
  anonymousRuntimes.clear();
  anonymousRuntimesBySignature.clear();
  runtimesBySessionId.clear();
  activeTurnRuntime = null;
}
