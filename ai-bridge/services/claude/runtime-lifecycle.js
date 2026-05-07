import { AsyncStream } from '../../utils/async-stream.js';
import { loadClaudeSdk } from '../../utils/sdk-loader.js';
import { createPreToolUseHook, normalizePermissionMode } from './permission-mode.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes as cleanupAnonymousFromRegistry,
  cleanupStaleSessionRuntimes as cleanupSessionsFromRegistry,
  clearActiveTurnRuntimeIf,
  endRuntimeTurn,
  findRuntimeForRequest,
  rememberRuntime,
  promoteRuntimeToSession,
  removeRuntime,
  touchRuntime
} from './runtime-registry.js';

let cachedQueryFn = null;

export function buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch) {
  const material = {
    cwd: options.cwd || '',
    additionalDirectories: options.additionalDirectories || [],
    systemPromptAppend: systemPromptAppend || '',
    streamingEnabled: !!streamingEnabled,
    runtimeSessionEpoch: runtimeSessionEpoch || '',
    model: options.model || '',
    effort: options.effort || ''
  };
  return JSON.stringify(material);
}

async function ensureQueryFn() {
  if (cachedQueryFn) return cachedQueryFn;
  const sdk = await loadClaudeSdk();
  const queryFn = sdk?.query;
  if (typeof queryFn !== 'function') {
    throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
  }
  cachedQueryFn = queryFn;
  return cachedQueryFn;
}

export function setCachedQueryFn(queryFn) {
  cachedQueryFn = queryFn;
}

export function resetCachedQueryFn() {
  cachedQueryFn = null;
}

export function registerRuntimeSession(runtime, sessionId, callbacks) {
  promoteRuntimeToSession(runtime, sessionId, callbacks);
}

export async function disposeRuntime(runtime, callbacks) {
  if (!runtime || runtime.closed) return;
  console.log('[LIFECYCLE] disposeRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + (runtime.runtimeSignature || '(none)'));
  runtime.closed = true;
  runtime.activeTurnCount = 0;

  try {
    runtime.inputStream.done();
  } catch (err) {
    console.error('[LIFECYCLE] inputStream.done() failed:', err?.message || err);
  }

  try {
    runtime.query?.close?.();
  } catch (err) {
    console.error('[LIFECYCLE] query.close() failed:', err?.message || err);
  }

  removeRuntime(runtime, callbacks?.removeSession);
  clearActiveTurnRuntimeIf(runtime);
}

async function createRuntime(requestContext, callbacks) {
  const queryFn = await ensureQueryFn();
  const initialPermissionMode = normalizePermissionMode(requestContext.permissionMode);

  const runtime = {
    closed: false,
    sessionId: requestContext.requestedSessionId || null,
    runtimeSessionEpoch: requestContext.runtimeSessionEpoch || null,
    runtimeSignature: requestContext.runtimeSignature,
    currentModel: requestContext.sdkModelName || null,
    currentPermissionMode: initialPermissionMode,
    permissionModeState: { value: initialPermissionMode },
    currentMaxThinkingTokens: requestContext.maxThinkingTokens ?? null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    activeTurnCount: 0,
    stderrLines: [],
    query: null,
    inputStream: new AsyncStream()
  };

  const options = {
    ...requestContext.options,
    stderr: (data) => {
      try {
        const text = (data ?? '').toString().trim();
        if (!text) return;
        runtime.stderrLines.push(text);
        if (runtime.stderrLines.length > 200) {
          runtime.stderrLines.shift();
        }
        console.error(`[SDK-STDERR] ${text}`);
      } catch (_) {
      }
    }
  };

  options.hooks = {
    ...(options.hooks || {}),
    PreToolUse: [{
      hooks: [createPreToolUseHook(runtime.permissionModeState, options.cwd, async (mode) => {
        if (runtime.currentPermissionMode === mode) {
          runtime.permissionModeState.value = mode;
          return;
        }
        if (typeof runtime.query?.setPermissionMode === 'function') {
          try {
            await runtime.query.setPermissionMode(mode);
          } catch (error) {
            console.warn('[LIFECYCLE] hook setPermissionMode failed, updating local state only:', error.message);
          }
        }
        // Always update local state to keep hook and runtime in sync
        runtime.currentPermissionMode = mode;
        runtime.permissionModeState.value = mode;
      })]
    }]
  };

  runtime.query = queryFn({
    prompt: runtime.inputStream,
    options
  });

  rememberRuntime(runtime, requestContext, callbacks?.registerActiveQueryResult);

  console.log('[LIFECYCLE] createRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + runtime.runtimeSignature);

  return runtime;
}

async function applyDynamicControls(runtime, requestContext) {
  if (!runtime || runtime.closed) return;

  const targetPermissionMode = normalizePermissionMode(requestContext.permissionMode);
  if (runtime.currentPermissionMode !== targetPermissionMode) {
    if (typeof runtime.query?.setPermissionMode === 'function') {
      try {
        await runtime.query.setPermissionMode(targetPermissionMode);
      } catch (error) {
        console.error('[DAEMON] setPermissionMode failed:', error.message);
      }
    }
    runtime.currentPermissionMode = targetPermissionMode;
    if (runtime.permissionModeState) {
      runtime.permissionModeState.value = targetPermissionMode;
    }
  }

  const targetModel = requestContext.sdkModelName || null;
  if (runtime.currentModel !== targetModel && typeof runtime.query?.setModel === 'function') {
    try {
      await runtime.query.setModel(targetModel || undefined);
      runtime.currentModel = targetModel;
    } catch (error) {
      console.error('[DAEMON] setModel failed:', error.message);
    }
  }

  const targetThinking = requestContext.maxThinkingTokens ?? null;
  if (runtime.currentMaxThinkingTokens !== targetThinking && typeof runtime.query?.setMaxThinkingTokens === 'function') {
    try {
      await runtime.query.setMaxThinkingTokens(targetThinking);
      runtime.currentMaxThinkingTokens = targetThinking;
    } catch (error) {
      console.error('[DAEMON] setMaxThinkingTokens failed:', error.message);
    }
  }
}

function assertRuntimeOwnership(runtime, requestContext) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    const err = new Error(
      `Runtime ownership mismatch: expected epoch ${requestContext.runtimeSessionEpoch}, got ${runtime.runtimeSessionEpoch || '(none)'}`
    );
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.requestedSessionId && runtime.sessionId && runtime.sessionId !== requestContext.requestedSessionId) {
    const err = new Error(
      `Runtime ownership mismatch: expected session ${requestContext.requestedSessionId}, got ${runtime.sessionId}`
    );
    err.runtimeTerminated = true;
    throw err;
  }
}

export async function acquireRuntime(requestContext, callbacks) {
  await cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));

  let runtime = findRuntimeForRequest(requestContext);

  if (runtime && runtime.runtimeSignature !== requestContext.runtimeSignature) {
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (runtime && requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    console.log('[LIFECYCLE] disposeRuntimeForEpochMismatch existing=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' requested=' + requestContext.runtimeSessionEpoch);
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (!runtime) {
    runtime = await createRuntime(requestContext, callbacks);
  } else {
    console.log('[LIFECYCLE] reuseRuntime sessionId=' + (runtime.sessionId || '(new)')
      + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' signature=' + runtime.runtimeSignature);
  }

  assertRuntimeOwnership(runtime, requestContext);
  await applyDynamicControls(runtime, requestContext);
  touchRuntime(runtime);
  return runtime;
}

export async function cleanupStaleAnonymousRuntimes(callbacks) {
  return cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export async function cleanupStaleSessionRuntimes(callbacks) {
  return cleanupSessionsFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export { beginRuntimeTurn, endRuntimeTurn, touchRuntime };
