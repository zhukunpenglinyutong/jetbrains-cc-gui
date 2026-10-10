/**
 * Persistent Codex runtime service (daemon mode).
 *
 * Owns one {@link CodexAppServerService} per chat host (session key =
 * channelId + sessionEpoch) and adapts it to the daemon command surface (design D4):
 *
 *  - long operations (codex.send / compact / review): session FIFO inside the
 *    service; the daemon commandQueue wraps the whole call and the request
 *    stays active until the native terminal;
 *  - control operations (codex.respondInteraction / abortTurn /
 *    updateSettings): BYPASS the daemon command queue — a reply must reach
 *    the peer while a send is still pending (R1);
 *  - read-only operations (listThreads / listModels / ...): independent
 *    control path, never occupy the send FIFO;
 *  - lifecycle (releaseThread / resetRuntime / shutdown): drain before close.
 *
 * codex_event envelopes are written through process.stdout._originalStdoutWrite
 * so they are process-level NDJSON and never get wrapped with whatever
 * activeRequestId happens to be current (D4: background notifications must not
 * impersonate the active request). Legacy markers go through console.log so
 * the daemon wraps them into the active request envelope on purpose.
 */

import { ClassifiedError, CodexAppServerClient } from './codex-appserver-client.js';
import { CodexAppServerService } from './codex-appserver-service.js';
import { resolveCodexCli } from './codex-cli-resolver.js';
import {
  buildCodexNativeRuntime,
  computeCodexRuntimeFingerprint,
} from './codex-native-runtime-config.js';
import { getCodemossDir } from '../../utils/path-utils.js';
import { join } from 'node:path';
import { CodexPrivacyIndex } from './codex-privacy-index.js';
import { readNativeHistoryPage } from './codex-native-history.js';
import { createNativeHistoryCounter } from './codex-history-message-count.js';
import { readNativeSubagent } from './codex-native-subagents.js';
import { projectCodexItemMessages } from './codex-item-projection.js';
import { isGuardianReviewThread } from './codex-thread-visibility.js';
import { settleCodexSessionTitle } from './codex-session-title.js';
import { generateCodexText } from './codex-text-service.js';
import { prepareCodexRuntimeEnvironment } from './codex-native-runtime-env.js';

// =============================================================================
// State
// =============================================================================

/** sessionKey → {service, launchOptions, fingerprint, createdAt} */
const sessionServices = new Map();
const nativeHistoryCounters = new WeakMap();

/**
 * Pristine base environment for codex runtime construction, captured once
 * after daemon startup env injection. processRequest applies request-scoped
 * `params.env` to the global process.env for the duration of a request; a
 * session service created concurrently with such a request (queue-bypassing
 * settings/catalog calls) must not bake those — possibly credential-bearing —
 * values into the codex child environment for the session's lifetime.
 */
let pristineBaseEnv = null;

/** Freeze the daemon's true base environment (call once after startup env setup). */
export function setCodexPristineBaseEnv(env) {
  pristineBaseEnv = Object.freeze({ ...(env ?? {}) });
}

/**
 * The frozen base environment, or the live one before startup completes.
 * CLI resolution must use this instead of process.env: request handlers apply
 * params.env to process.env, and an injected CODEX_BIN/CODEX_PATH/CODEX_CLI_PATH
 * would otherwise redirect the app-server child to an attacker binary.
 */
export function getCodexPristineBaseEnv() {
  return pristineBaseEnv ?? process.env;
}

function sessionKeyOf(stdinData) {
  const channelId = String(stdinData?.channelId ?? stdinData?.sessionId ?? 'default').trim();
  const epoch = String(stdinData?.sessionEpoch ?? '').trim();
  return `${channelId}::${epoch}`;
}

function emitProcessLevel(obj) {
  const write = process.stdout._originalStdoutWrite;
  if (write) {
    write.call(process.stdout, JSON.stringify(obj) + '\n', 'utf8');
  } else {
    // Non-daemon mode (direct node execution): plain stdout.
    process.stdout.write(JSON.stringify(obj) + '\n', 'utf8');
  }
}

function markerLine(text) {
  // console.log is intercepted by the daemon and wrapped with the CURRENT
  // activeRequestId — exactly right for operation-scoped markers.
  console.log(text);
}

function captureOperationMarkers(operation) {
  operation.emitter = (event) => {
    if (typeof event === 'string') markerLine(event);
    else if (event?.marker === 'OPERATION_DONE') {
      markerLine(`[MESSAGE_END] ${JSON.stringify({ clientOperationId: event.clientOperationId })}`);
    }
  };
}

// =============================================================================
// Service lifecycle per session
// =============================================================================

function resolveCliCommand(stdinData) {
  const resolution = resolveCodexCli({
    explicitPath: stdinData?.codexCliPath || null,
    depsRoot: join(getCodemossDir(), 'dependencies', 'codex-sdk', 'node_modules'),
    nodePath: process.execPath,
    env: getCodexPristineBaseEnv(),
  });
  if (resolution.status !== 'resolved') {
    const error = new Error(resolution.reason || 'Codex CLI not found');
    error.code = 'CODEX_CLI_UNRESOLVED';
    throw error;
  }
  return resolution;
}

/**
 * Ordered CLI launch plan for one chat host: the resolved candidates, most
 * preferred first, with installs whose completeness could not be confirmed
 * demoted to the end. The service falls back to the next candidate when one
 * dies before its handshake completes.
 */
function resolveCliPlan(stdinData) {
  if (Array.isArray(stdinData?.codexCommandPrefix) && stdinData.codexCommandPrefix.length > 0) {
    return {
      candidates: [{ command: stdinData.codexCommandPrefix, label: stdinData.codexCommandPrefix.join(' '), source: 'injected' }],
      rejected: [],
      source: 'injected',
    };
  }
  const resolution = resolveCliCommand(stdinData);
  // Support-visible: skipped/demoted installs never surface as a runtime
  // failure, so their reason has to be logged here.
  if (resolution.rejected?.length) {
    console.error('[CODEX-SERVER] unusable Codex CLI ignored: '
      + resolution.rejected.map((entry) => `${entry.path} (${entry.reason})`).join('; '));
  }
  const suspects = (resolution.candidates ?? []).filter((entry) => entry.suspect);
  if (suspects.length > 0) {
    console.error('[CODEX-SERVER] unconfirmed Codex CLI kept as last resort: '
      + suspects.map((entry) => `${entry.label} (${entry.reason})`).join('; '));
  }
  return { candidates: resolution.candidates ?? [{ command: resolution.command, label: resolution.command.join(' '), source: resolution.source }],
    rejected: resolution.rejected ?? [], source: resolution.source };
}

/**
 * Get (or create) the persistent service for this chat host. A launch-config
 * fingerprint change rebuilds the service at the service's idle boundary.
 */
function ensureSessionService(stdinData, { nativeEnvironmentDependencies = {} } = {}) {
  const sessionKey = sessionKeyOf(stdinData);
  const existing = sessionServices.get(sessionKey);
  // Controls and catalog reads carry only routing data. Preserve the launch
  // configuration captured by send until an explicit field replaces it.
  stdinData = { ...(existing?.launchData ?? {}), ...stdinData };

  const authMode = stdinData?.apiKey || stdinData?.baseUrl ? 'managed' : (stdinData?.authMode ?? 'cli_login');
  const launchInputs = {
    authMode,
    apiKey: stdinData?.apiKey || null,
    baseUrl: stdinData?.baseUrl || null,
    providerLabel: stdinData?.providerLabel || null,
    headers: stdinData?.httpHeaders || null,
    codexHome: stdinData?.codexHome || null,
    developerInstructions: stdinData?.developerInstructions ?? null,
    providerRevision: stdinData?.providerRevision ?? null,
    cliSource: stdinData?.codexCliPath || (Array.isArray(stdinData?.codexCommandPrefix)
      ? JSON.stringify(stdinData.codexCommandPrefix) : null),
    projectDocFallbackFilenames: Array.isArray(stdinData?.projectDocFallbackFilenames)
      ? [...stdinData.projectDocFallbackFilenames] : null,
  };
  const baseEnv = { ...(pristineBaseEnv ?? process.env) };
  const runtime = buildCodexNativeRuntime({
    ...launchInputs,
    projectDocFallbackFilenames: stdinData?.projectDocFallbackFilenames,
    baseEnv,
  });
  const launchOptions = {
    ...launchInputs,
    cwd: stdinData?.cwd,
    nativeConfig: runtime.config,
    modelProvider: runtime.modelProvider,
  };

  const fingerprint = computeCodexRuntimeFingerprint(launchInputs);
  if (existing && fingerprint === existing.fingerprint) {
    return { sessionKey, service: existing.service };
  }

  // An explicit override re-resolves on every call; otherwise the host keeps
  // the plan captured when it was created.
  const cliPlan = (!existing || stdinData?.codexCliPath || Array.isArray(stdinData?.codexCommandPrefix))
    ? resolveCliPlan(stdinData)
    : existing.cliPlan;
  const commandPrefix = cliPlan.candidates[0].command;
  const launchData = Object.fromEntries([
    'authMode', 'apiKey', 'baseUrl', 'providerLabel', 'httpHeaders', 'codexHome',
    'developerInstructions', 'providerRevision', 'projectDocFallbackFilenames', 'codexCliPath',
    'codexCommandPrefix', 'pluginVersion',
  ].filter((key) => Object.hasOwn(stdinData, key)).map((key) => [key, stdinData[key]]));
  let candidateIndex = 0;
  const createClient = async () => {
    const candidate = cliPlan.candidates[candidateIndex] ?? cliPlan.candidates[0];
    let sensitiveEnvNames = [];
    const env = await prepareCodexRuntimeEnvironment({ authMode, baseEnv, codexHome: launchInputs.codexHome,
      onCredentialNames: names => { sensitiveEnvNames = names; },
      config: runtime.config, env: {
        ...runtime.env,
        ...(launchInputs.codexHome || baseEnv.CODEX_HOME
          ? { CODEX_HOME: launchInputs.codexHome || baseEnv.CODEX_HOME } : {}),
      },
    }, nativeEnvironmentDependencies);
    return new CodexAppServerClient({
      // CodexAppServerClient appends the transport arguments itself. Keeping
      // only the executable prefix here prevents spawning app-server twice.
      command: candidate.command,
      cwd: stdinData?.cwd || undefined,
      env, sensitiveEnvNames,
      clientInfo: {
        name: 'codemoss_intellij',
        title: 'CC GUI',
        version: String(stdinData?.pluginVersion ?? '0.0.0'),
      },
    });
  };
  /** Called by the service after a start that died before READY. */
  createClient.advance = () => {
    if (candidateIndex + 1 >= cliPlan.candidates.length) {
      return null;
    }
    candidateIndex += 1;
    return cliPlan.candidates[candidateIndex];
  };
  /** The candidate currently in use, for auxiliary CLI work (titles, text). */
  createClient.currentCommand = () => (cliPlan.candidates[candidateIndex] ?? cliPlan.candidates[0]).command;

  if (existing) {
    // Propagate launch-config changes; the service rebuilds when idle.
    existing.fingerprint = fingerprint;
    existing.launchOptions = launchOptions;
    existing.launchData = launchData;
    existing.cliPlan = cliPlan;
    existing.currentCliCommand = createClient.currentCommand;
    existing.commandPrefix = commandPrefix;
    existing.nativeRuntime = runtime;
    existing.titleAbort?.abort();
    existing.service.clientFactory = createClient;
    existing.service.startupAttempts = cliPlan.candidates.length;
    existing.service.notifyLaunchConfigChange(launchOptions, fingerprint);
    return { sessionKey, service: existing.service };
  }

  const service = new CodexAppServerService({
    sessionEpoch: String(stdinData?.sessionEpoch ?? Date.now()),
    channelId: String(stdinData?.channelId ?? stdinData?.sessionId ?? 'codex'),
    launchOptions,
    runtimeFingerprint: fingerprint,
    // One attempt per resolved CLI: a broken install must not fail the turn
    // while a working CLI for the same config is already known.
    startupAttempts: cliPlan.candidates.length,
    privacyIndex: new CodexPrivacyIndex({
      rootDir: join(getCodemossDir(), 'codex-privacy'),
      scope: String(stdinData?.codexHome || process.env.CODEX_HOME || 'default'),
    }),
  });

  // codexCommandPrefix is a test-only injection mirroring the Java-side
  // PeerCommandProvider contract: the daemon points the transport at the
  // controlled stdio peer. Production never sends this field.
  service.clientFactory = createClient;

  service.on('codex_event', (event) => emitProcessLevel(event));
  service.on('runtimeStateChanged', ({ state, runtimeGeneration, runtimePid }) => {
    emitProcessLevel({
      type: 'daemon',
      event: 'codex_event',
      provider: 'codex',
      channelId: stdinData?.channelId ?? 'codex',
      sessionEpoch: service.sessionEpoch,
      kind: 'runtimeStateChanged',
      payload: { state, runtimeGeneration, runtimePid },
    });
  });
  service.on('stderrLine', (line) => {
    console.error(`[CODEX-SERVER] ${line}`);
  });
  service.on('runtimeFallback', ({ attempt, from, to, reason }) => {
    console.error(`[CODEX-SERVER] CLI fallback #${attempt}: ${from} failed (${reason}); retrying with ${to}`);
  });

  sessionServices.set(sessionKey, { service, launchOptions, launchData, commandPrefix, cliPlan,
    currentCliCommand: createClient.currentCommand, nativeRuntime: runtime,
    fingerprint, createdAt: Date.now() });
  return { sessionKey, service };
}

function getServiceOrNull(stdinData) {
  const entry = sessionServices.get(sessionKeyOf(stdinData));
  return entry?.service ?? null;
}

// =============================================================================
// Operation settings assembly
// =============================================================================

function buildTurnSettings(stdinData) {
  const settings = {};
  const permissionMode = typeof stdinData?.permissionMode === 'string'
    ? stdinData.permissionMode.trim() : '';
  if (permissionMode) {
    if (!stdinData?.approvalPolicy) {
      settings.approvalPolicy = permissionMode === 'bypassPermissions' || permissionMode === 'yolo'
        ? 'never' : 'on-request';
    }
    if (!stdinData?.sandbox) {
      settings.sandbox = permissionMode === 'bypassPermissions' || permissionMode === 'yolo'
        ? 'danger-full-access' : permissionMode === 'readOnly' ? 'read-only' : 'workspace-write';
    }
    settings.approvalsReviewer = permissionMode === 'auto' ? 'auto_review' : 'user';
  }
  if (stdinData?.model) {
    settings.model = stdinData.model;
  }
  if (stdinData?.reasoningEffort) {
    settings.effort = stdinData.reasoningEffort;
  }
  if (stdinData?.serviceTier !== undefined) {
    // Java's standard-mode value is empty; native omission would preserve Fast.
    settings.serviceTier = stdinData.serviceTier === '' ? null : stdinData.serviceTier;
  }
  if (stdinData?.approvalPolicy) {
    settings.approvalPolicy = stdinData.approvalPolicy;
  }
  if (stdinData?.approvalPreset) {
    const preset = stdinData.approvalPreset;
    if (preset === 'request') {
      settings.approvalPolicy = 'on-request';
      settings.approvalsReviewer = 'user';
    } else if (preset === 'auto') {
      settings.approvalPolicy = 'on-request';
      settings.approvalsReviewer = 'auto_review';
    } else if (preset === 'sandboxed-auto') {
      settings.approvalPolicy = 'never';
      settings.approvalsReviewer = 'auto_review';
      settings.sandbox ??= 'workspace-write';
    } else if (preset === 'full-access') {
      settings.approvalPolicy = 'never';
      settings.approvalsReviewer = 'auto_review';
      settings.sandbox ??= 'danger-full-access';
    }
  }
  if (stdinData?.approvalsReviewer) {
    settings.approvalsReviewer = stdinData.approvalsReviewer;
  }
  if (stdinData?.sandbox) {
    settings.sandbox = stdinData.sandbox;
  }
  if (stdinData?.sandboxSelection) {
    settings.sandbox = stdinData.sandboxSelection;
  }
  if (stdinData?.collaborationMode) {
    settings.collaborationMode = typeof stdinData.collaborationMode === 'string'
      ? { mode: stdinData.collaborationMode, settings: {
        model: String(stdinData?.model || ''),
        reasoning_effort: stdinData?.reasoningEffort || null,
        developer_instructions: stdinData?.developerInstructions ?? null,
      } }
      : stdinData.collaborationMode;
  }
  if (stdinData?.developerInstructions !== undefined) {
    settings.developerInstructions = stdinData.developerInstructions;
  }
  if (stdinData?.cwd) {
    settings.cwd = stdinData.cwd;
    settings.cwdExplicit = stdinData.cwdExplicit === true;
  }
  if (!settings.collaborationMode && permissionMode) {
    const collaborationMode = permissionMode === 'plan' ? 'plan' : 'default';
    settings.collaborationMode = {
      mode: collaborationMode,
      settings: {
        model: String(stdinData?.model || ''),
        reasoning_effort: stdinData?.reasoningEffort || null,
        developer_instructions: stdinData?.developerInstructions ?? null,
      },
    };
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

/** Native UserInput items from the Java payload (text + localImage). */
function buildNativeInput(stdinData) {
  const input = [];
  const message = stdinData?.message;
  if (typeof message === 'string' && message.length > 0) {
    input.push({ type: 'text', text: message });
  }
  for (const attachment of stdinData?.attachments ?? []) {
    if (attachment?.path) {
      input.push({ type: 'localImage', path: attachment.path });
    }
  }
  for (const skill of stdinData?.skills ?? []) {
    if (typeof skill?.name === 'string' && typeof skill?.path === 'string') {
      input.push({ type: 'skill', name: skill.name, path: skill.path });
    }
  }
  return input;
}

// =============================================================================
// Daemon command surface
// =============================================================================

/**
 * Bootstrap announces the thread before the opening turn completes. Listening
 * avoids a polling claim that can outlive a failed send and block its retry.
 */
function waitForOperationThreadId(service, operation, signal) {
  return new Promise(resolve => {
    let finished = false;
    const finish = threadId => {
      if (finished) return;
      finished = true;
      service.off('codex_event', onEvent);
      signal.removeEventListener('abort', onAbort);
      resolve(signal.aborted ? null : threadId ?? null);
    };
    const onEvent = event => {
      if (event.kind === 'threadStarted' && service.activeOperationId === operation.clientOperationId
          && !operation.settled) finish(event.threadId);
    };
    const onAbort = () => finish(null);
    service.on('codex_event', onEvent);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.promise.then(() => finish(operation.threadId), () => finish(null));
    if (signal.aborted || operation.settled || operation.threadId) finish(operation.threadId);
  });
}

/** Long operation: runs inside the daemon commandQueue until terminal. */
export async function codexSendPersistent(stdinData, { titleDependencies = {}, nativeEnvironmentDependencies = {} } = {}) {
  const { service, sessionKey } = ensureSessionService(stdinData, { nativeEnvironmentDependencies });
  const entry = sessionServices.get(sessionKey);
  const firstNewThread = !stdinData?.threadId && !service.rootThreadId && !service.desiredThreadId;
  const clientMessageId = stdinData?.clientMessageId
    || stdinData?.messageId
    || `cm-${Date.now()}`;
  const operation = service.enqueueOperation({
    kind: 'send',
    threadId: stdinData?.threadId || null,
    clientMessageId,
    settings: buildTurnSettings(stdinData) ?? undefined,
    markerPayload: { input: buildNativeInput(stdinData) },
  });
  // Capture the marker emitter so legacy markers carry this operation's
  // identity even while background events flow through the process channel.
  captureOperationMarkers(operation);
  markerLine('[MESSAGE_START]');
  // Name the thread while the turn runs: the title request uses its own
  // app-server child and thread/name/set is a direct RPC, so neither competes
  // with the live operation. Waiting for the turn to settle delayed the title
  // by the whole run — minutes on long tasks.
  if (firstNewThread && !entry.titleAttempted) {
    if (!entry.titleAbort || entry.titleAbort.signal.aborted) entry.titleAbort = new AbortController();
    const { signal } = entry.titleAbort;
    const titleTask = (async () => {
      const threadId = await waitForOperationThreadId(service, operation, signal);
      if (!threadId || signal.aborted || entry.titleAttempted) return;
      // Claim only a created thread, so failed bootstraps leave queued retries eligible.
      entry.titleAttempted = true;
      const generation = service.runtimeGeneration;
      const fingerprint = entry.fingerprint;
      // Optional metadata reads must not restart a failed or retiring writer.
      const canApply = () => sessionServices.get(sessionKey) === entry && !signal.aborted
        && service.state === 'ready' && service.client?.alive
        && entry.fingerprint === fingerprint && service.runtimeGeneration === generation && service.rootThreadId === threadId;
      await settleCodexSessionTitle({ service, threadId, userMessage: stdinData.message, canApply,
        generateText: input => generateCodexText({ ...input, model: stdinData.model }, {
          runtimeState: () => ({ access: entry.launchOptions.authMode }),
          resolveCli: () => ({ status: 'resolved', command: entry.currentCliCommand?.() ?? entry.commandPrefix }),
          nativeRuntime: { ...entry.nativeRuntime, env: { ...entry.nativeRuntime.env,
            ...(entry.launchOptions.codexHome ? { CODEX_HOME: entry.launchOptions.codexHome } : {}) } },
          baseEnv: pristineBaseEnv ?? process.env, nativeEnvironmentDependencies,
          cwd: stdinData.cwd, timeoutMs: 15_000, signal,
        }),
      }, titleDependencies);
    })();
    // Several sends can queue before bootstrap; teardown must cancel and await
    // all their listeners even though only the first created thread gets named.
    entry.titleTask = Promise.all([entry.titleTask, titleTask]).then(() => {});
  }
  return await operation.promise;
}

/** Execute one current native plan item as a fresh default-mode turn. */
export async function codexExecutePlanPersistent(stdinData) {
  const { service } = ensureSessionService(stdinData);
  const threadId = stdinData?.threadId || service.rootThreadId;
  if (!threadId) {
    throw new Error('Start a Codex conversation before executing a plan');
  }
  if (service.busy || service.queue.length > 0) throw new Error('Wait for the current Codex operation before executing a plan');
  const planItemId = String(stdinData?.planItemId || '').trim();
  const text = String(stdinData?.planText || '').trim();
  if (!text) {
    throw new Error('The selected Codex plan has no executable text');
  }
  const stalePlan = () => Object.assign(new Error('The selected Codex plan is stale, changed or belongs to another thread'),
    { code: 'STALE_PLAN' });
  const reviewed = service.snapshot().planItems.find(item => item.id === planItemId
    && item.threadId === threadId && item.authoritative && item.text?.trim() === text);
  if (!reviewed) throw stalePlan();
  const generation = service.runtimeGeneration;
  // Verify the native latest turn as another client can replace the reviewed
  // plan while this browser still displays its earlier version.
  const page = await service.readOnly('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
  });
  if (!Array.isArray(page?.data)) throw new Error('Native plan verification returned no turn page');
  const latest = page.data[0];
  const nativePlan = latest?.items?.find(item => item.type === 'plan' && item.id === planItemId);
  if (latest?.id !== reviewed.turnId || latest?.status !== 'completed' || nativePlan?.text?.trim() !== text
      || service.runtimeGeneration !== generation || service.rootThreadId !== threadId
      || service.busy || service.queue.length > 0) throw stalePlan();
  const operation = service.enqueueOperation({
    kind: 'send',
    threadId,
    clientMessageId: stdinData?.clientMessageId || `cm-plan-${Date.now()}`,
    settings: {
      ...(service.desiredSettings || {}),
      ...(buildTurnSettings(stdinData) || {}),
      collaborationMode: { mode: 'default', settings: {
        model: String(stdinData?.model || service.effectiveSettings?.model || ''),
        reasoning_effort: stdinData?.reasoningEffort || null,
        developer_instructions: stdinData?.developerInstructions ?? null,
      } },
    },
    markerPayload: { input: [{ type: 'text', text: `Implement the following plan:\n\n${text}` }] },
  });
  captureOperationMarkers(operation);
  markerLine('[MESSAGE_START]');
  return await operation.promise;
}

/** Long operation: native compaction via the session FIFO. */
export async function codexCompactPersistent(stdinData) {
  const { service } = ensureSessionService(stdinData);
  const threadId = stdinData?.threadId || service.rootThreadId;
  if (!threadId) {
    throw new ClassifiedError('NO_THREAD', 'Start a Codex conversation before compacting it');
  }
  const operation = service.enqueueOperation({
    kind: 'compact',
    threadId,
    settings: buildTurnSettings(stdinData) ?? undefined,
  });
  captureOperationMarkers(operation);
  markerLine('[MESSAGE_START]');
  return await operation.promise;
}

/** Long operation: native inline review via the session FIFO. */
export async function codexReviewPersistent(stdinData) {
  const { service } = ensureSessionService(stdinData);
  const threadId = stdinData?.threadId || service.rootThreadId;
  if (!threadId) {
    throw new ClassifiedError('NO_THREAD', 'Start a Codex conversation before reviewing it');
  }
  const operation = service.enqueueOperation({
    kind: 'review',
    threadId,
    settings: buildTurnSettings(stdinData) ?? undefined,
  });
  captureOperationMarkers(operation);
  markerLine('[MESSAGE_START]');
  return await operation.promise;
}

/** Control operation: connect and bind/resume the thread without a turn. */
export async function codexPreconnectPersistent(stdinData, { nativeEnvironmentDependencies = {} } = {}) {
  const { service } = ensureSessionService(stdinData, { nativeEnvironmentDependencies });
  try {
    return await service.preconnect({ threadId: stdinData?.threadId || null });
  } catch (error) {
    await service.resetRuntime({ reason: 'preconnect-failed' });
    throw error;
  }
}

/** Execute a native read-only catalog/history request on the active session. */
async function codexReadOnlyPersistent(method, stdinData = {}) {
  const { service } = ensureSessionService(stdinData);
  const params = { ...(stdinData.params ?? {}) };
  if (stdinData.cwd && method === 'thread/list' && params.cwd === undefined) params.cwd = stdinData.cwd;
  if (stdinData.cwd && method === 'skills/list' && params.cwds === undefined) params.cwds = [stdinData.cwd];
  if (method === 'mcpServerStatus/list' && params.threadId === undefined && service.rootThreadId
      && service.threads.get(service.rootThreadId)?.state !== 'unloaded') params.threadId = service.rootThreadId;
  if (stdinData.threadId && ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(method)
      && params.threadId === undefined) params.threadId = stdinData.threadId;
  if (stdinData.cursor !== undefined && params.cursor === undefined) params.cursor = stdinData.cursor;
  if (stdinData.limit !== undefined && params.limit === undefined) params.limit = stdinData.limit;
  if (stdinData.sortDirection !== undefined && params.sortDirection === undefined) {
    params.sortDirection = stdinData.sortDirection;
  }
  if (typeof stdinData.excludeTurns === 'boolean' && params.excludeTurns === undefined) params.excludeTurns = stdinData.excludeTurns;
  return await service.readOnly(method, params);
}

export async function codexListThreadsPersistent(stdinData) {
  const projectPath = stdinData?.params?.projectPath ?? stdinData?.cwd;
  const params = {
    cwd: null,
    modelProviders: [],
    sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
      'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
    ...stdinData?.params,
  };
  delete params.projectPath;
  const result = await codexReadOnlyPersistent('thread/list', { ...stdinData, params });
  return { ...result, data: filterCodexProjectThreads(result.data, projectPath) };
}

/** Counts history independently so listing metadata never waits for full transcripts. */
export async function codexCountThreadMessagesPersistent(stdinData) {
  const { service } = ensureSessionService(stdinData);
  let count = nativeHistoryCounters.get(service);
  if (!count) {
    count = createNativeHistoryCounter((method, params) => service.readOnly(method, params));
    nativeHistoryCounters.set(service, count);
  }
  const threadId = stdinData.threadId;
  return { threadId, messageCount: await count({ ...stdinData.params, id: threadId }) };
}

/** Keeps descendant directories while honoring Windows case and project boundaries. */
export function filterCodexProjectThreads(threads, projectPath) {
  const normalize = (path) => String(path ?? '').replaceAll('\\', '/').replace(/\/$/, '')
    .replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  const normalizeProject = (path) => {
    const normalized = normalize(path);
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  };
  const roots = (Array.isArray(projectPath) ? projectPath : [projectPath]).map(normalizeProject).filter(Boolean);
  return (threads ?? []).filter((thread) => {
    if (isGuardianReviewThread(thread)) return false;
    if (!roots.length) return true;
    const path = normalizeProject(thread.cwd);
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
  });
}

/** Projects native history through the same item adapter used by live messages. */
export async function codexReadHistoryPagePersistent(stdinData) {
  const { service } = ensureSessionService(stdinData);
  return await readNativeHistoryPage((method, params) => service.readOnly(method, params), {
    threadId: stdinData.threadId, ...stdinData.params,
  });
}

/** Reads verified native child history or status without resuming either thread. */
export async function codexReadSubagentPersistent(stdinData) {
  const { service } = ensureSessionService(stdinData);
  return await readNativeSubagent((method, params) => service.readOnly(method, params), {
    ...stdinData.params, rootThreadId: stdinData.threadId,
  });
}

export async function codexReadThreadPersistent(stdinData) {
  const { fileChangesOnly, ...params } = stdinData?.params ?? {};
  const result = await codexReadOnlyPersistent('thread/read', { ...stdinData, params });
  if (params.includeTurns !== true || !result?.thread) return result;
  const fileChangeMessages = projectThreadFileChanges(result.thread);
  // Avoid copying the command transcript merely to populate the file list.
  return fileChangesOnly ? { thread: { id: result.thread?.id,
    ...(result.thread?.name ? { name: result.thread.name } : {}) }, fileChangeMessages } : { ...result, fileChangeMessages };
}

/** Keeps the edit ledger independent of the visible conversation's pagination. */
export function projectThreadFileChanges(thread) {
  return (thread?.turns ?? []).flatMap(turn => (turn.items ?? [])
    .filter(item => item.type === 'fileChange' || item.type === 'file_change')
    .flatMap(item => projectCodexItemMessages(item, { threadId: thread.id, turnId: turn.id, authoritative: true })));
}

export async function codexListModelsPersistent(stdinData) {
  return await codexReadOnlyPersistent('model/list', stdinData);
}

export async function codexListSkillsPersistent(stdinData) {
  return await codexReadOnlyPersistent('skills/list', stdinData);
}

export async function codexGetMcpStatusPersistent(stdinData) {
  return await codexReadOnlyPersistent('mcpServerStatus/list', stdinData);
}

export async function codexReloadMcpPersistent(stdinData) {
  return await codexReadOnlyPersistent('config/mcpServer/reload', stdinData);
}

/** Control operation (bypasses queue): reply to a native interaction. */
export async function codexRespondInteractionPersistent(stdinData) {
  const service = getServiceOrNull(stdinData);
  if (!service) {
    throw new Error('codex runtime is not connected for this session');
  }
  const replied = service.respondInteraction(stdinData.rpcId, stdinData.result ?? {});
  if (!replied) {
    const error = new Error('invalid native Codex interaction result');
    error.code = 'INVALID_INTERACTION_RESULT';
    throw error;
  }
  return { replied: true };
}

/** Control operation (bypasses queue): typed error reply. */
export async function codexRespondInteractionErrorPersistent(stdinData) {
  const service = getServiceOrNull(stdinData);
  if (!service) {
    throw new Error('codex runtime is not connected for this session');
  }
  if (!service.respondInteractionError(stdinData.rpcId, stdinData.code, stdinData.message)) {
    throw new Error('Unknown or stale Codex interaction');
  }
  return { replied: true };
}

/** Control operation (bypasses queue): stop the active turn. */
export async function codexAbortTurnPersistent(stdinData) {
  const service = getServiceOrNull(stdinData);
  if (!service) {
    return { stopped: false, reason: 'no-runtime' };
  }
  // The user asked this turn to stop, so its auxiliary naming work stops too;
  // a lingering title child would otherwise keep an app-server process alive.
  sessionServices.get(sessionKeyOf(stdinData))?.titleAbort?.abort();
  const activeId = service.activeOperationId;
  if (!activeId) {
    const queued = service.queue[0];
    return queued ? service.stopOperation(queued.clientOperationId)
      : { stopped: false, reason: 'no-active-operation' };
  }
  return service.stopOperation(activeId);
}

/** Control operation: record desired settings (effectiveness via notification). */
export async function codexUpdateSettingsPersistent(stdinData) {
  const { service } = ensureSessionService(stdinData);
  const settings = {
    ...(buildTurnSettings(stdinData) || {}),
    ...(stdinData?.settings && typeof stdinData.settings === 'object' ? stdinData.settings : {}),
  };
  if (settings.approvalPreset) {
    const preset = settings.approvalPreset;
    delete settings.approvalPreset;
    if (preset === 'request') {
      settings.approvalPolicy = 'on-request';
      settings.approvalsReviewer = 'user';
    } else if (preset === 'auto') {
      settings.approvalPolicy = 'on-request';
      settings.approvalsReviewer = 'auto_review';
    } else if (preset === 'sandboxed-auto') {
      settings.approvalPolicy = 'never';
      settings.approvalsReviewer = 'auto_review';
      settings.sandbox ??= 'workspace-write';
    } else if (preset === 'full-access') {
      settings.approvalPolicy = 'never';
      settings.approvalsReviewer = 'auto_review';
      settings.sandbox ??= 'danger-full-access';
    }
  }
  if (settings.sandboxSelection) {
    settings.sandbox = settings.sandboxSelection;
    delete settings.sandboxSelection;
    delete settings.sandboxSource;
  }
  if (typeof settings.collaborationMode === 'string') {
    settings.collaborationMode = {
      mode: settings.collaborationMode,
      settings: {
        model: String(stdinData?.model || ''),
        reasoning_effort: stdinData?.reasoningEffort || null,
        developer_instructions: stdinData?.developerInstructions ?? null,
      },
    };
  }
  delete settings.cwd;
  const { revision } = service.updateSettings(settings);
  return { revision, applied: false };
}

/** Lifecycle: release a thread and drain its relation set. */
export async function codexReleaseThreadPersistent(stdinData) {
  const service = getServiceOrNull(stdinData);
  if (!service) {
    return { released: null };
  }
  const entry = sessionServices.get(sessionKeyOf(stdinData));
  entry?.titleAbort?.abort();
  try {
    return await service.releaseThread(stdinData?.threadId || null);
  } finally {
    await entry?.titleTask;
    if (sessionServices.get(sessionKeyOf(stdinData))?.service === service) sessionServices.delete(sessionKeyOf(stdinData));
  }
}

/** Lifecycle: tear the runtime down (drain, close, confirm exit). */
export async function codexResetRuntimePersistent(stdinData) {
  const sessionKey = sessionKeyOf(stdinData);
  const entry = sessionServices.get(sessionKey);
  if (!entry) {
    return { reset: false };
  }
  entry.titleAbort?.abort();
  await entry.service.resetRuntime({ reason: stdinData?.reason ?? 'requested' });
  await entry.titleTask;
  if (stdinData?.dispose) {
    sessionServices.delete(sessionKey);
  }
  return { reset: true };
}

/** Read-only: runtime snapshot for heartbeat/status. */
export function getCodexRuntimeSnapshot() {
  const sessions = [];
  for (const [sessionKey, entry] of sessionServices) {
    const snap = entry.service.snapshot();
    sessions.push({
      sessionKey,
      state: snap.state,
      runtimeGeneration: snap.runtimeGeneration,
      runtimePid: snap.runtimePid,
      rootThreadId: snap.rootThreadId,
      busy: snap.busy,
      queueLength: snap.queueLength,
    });
  }
  return {
    sessionCount: sessions.length,
    sessions,
    busy: sessions.some((session) => session.busy),
  };
}

/** Lifecycle: tear down every session runtime (shutdown / idle reaper). */
export async function codexShutdownPersistentRuntimes() {
  const teardowns = [];
  for (const [sessionKey, entry] of [...sessionServices]) {
    entry.titleAbort?.abort();
    teardowns.push(
      Promise.all([entry.service.resetRuntime({ reason: 'shutdown' }).catch(() => {}), entry.titleTask])
    );
    sessionServices.delete(sessionKey);
  }
  await Promise.all(teardowns);
  return { shutDown: teardowns.length };
}
