/** Ephemeral native text requests for prompt enhancement and commit generation. */
import { getCodexRuntimeState } from '../../config/api-config.js';
import { join } from 'node:path';
import { getRealHomeDir, getCodemossDir } from '../../utils/path-utils.js';
import { CodexAppServerClient, ClassifiedError } from './codex-appserver-client.js';
import { CodexAppServerService } from './codex-appserver-service.js';
import { resolveCodexCli } from './codex-cli-resolver.js';
import { getCodexPristineBaseEnv } from './persistent-codex-service.js';
import { buildCodexNativeRuntime } from './codex-native-runtime-config.js';
import { prepareCodexRuntimeEnvironment } from './codex-native-runtime-env.js';

function declineInteraction(method) {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null };
  return { decision: 'decline' };
}

/**
 * Generate text through an isolated, read-only app-server thread.
 * Dependencies are injected only by tests, never from browser request data.
 */
export async function generateCodexText({
  prompt, model, effort, developerInstructions = '', onDelta = null,
}, {
  runtimeState = getCodexRuntimeState,
  resolveCli = () => resolveCodexCli({
    depsRoot: join(getCodemossDir(), 'dependencies', 'codex-sdk', 'node_modules'),
    nodePath: process.execPath,
    // Never resolve against the live process.env: request handlers inject
    // params.env into it, and a CODEX_* path override would hijack the child.
    env: getCodexPristineBaseEnv(),
  }),
  clientFactory = (options) => new CodexAppServerClient(options),
  baseEnv = process.env,
  cwd = getRealHomeDir(),
  timeoutMs = 120_000,
  nativeRuntime = null,
  nativeEnvironmentDependencies = {},
  signal = null,
} = {}) {
  // The native configuration is synchronized by the provider manager. Reading
  // it stays native, but authorization must precede discovery and child startup.
  const state = runtimeState();
  if (!['managed', 'cli_login'].includes(state?.access)) {
    throw new ClassifiedError('CODEX_ACCESS_INACTIVE', 'Enable a Codex provider or authorize CLI Login first');
  }
  const resolution = resolveCli();
  if (resolution.status !== 'resolved') {
    throw new ClassifiedError('CODEX_CLI_UNRESOLVED', resolution.reason || 'Codex CLI not found. Check Provider Management > CLI.');
  }
  if (signal?.aborted) throw new ClassifiedError('CODEX_TEXT_CANCELLED', 'Codex text request cancelled');
  const launchBaseEnv = { ...baseEnv };
  const runtime = nativeRuntime ?? buildCodexNativeRuntime({ authMode: state.access, baseEnv: launchBaseEnv });
  const messages = new Map();
  let anonymousText = '';
  const service = new CodexAppServerService({
    clientFactory: async () => {
      let sensitiveEnvNames = [];
      const env = await prepareCodexRuntimeEnvironment({ authMode: state.access, baseEnv: launchBaseEnv,
        onCredentialNames: names => { sensitiveEnvNames = names; },
        config: runtime.config, env: { ...runtime.env,
          ...(runtime.env.CODEX_HOME || launchBaseEnv.CODEX_HOME
            ? { CODEX_HOME: runtime.env.CODEX_HOME || launchBaseEnv.CODEX_HOME } : {}) },
      }, nativeEnvironmentDependencies);
      return clientFactory({ command: resolution.command, cwd, env, sensitiveEnvNames });
    },
    launchOptions: { cwd, nativeConfig: runtime.config, modelProvider: runtime.modelProvider },
    emitMarker: (_operation, marker) => {
      if (typeof marker !== 'string') return;
      if (marker.startsWith('[CONTENT_DELTA] ')) {
        const delta = JSON.parse(marker.slice('[CONTENT_DELTA] '.length));
        if (typeof delta === 'string') {
          anonymousText += delta;
          onDelta?.(delta);
        }
        return;
      }
      if (!marker.startsWith('[MESSAGE] ')) return;
      const message = JSON.parse(marker.slice('[MESSAGE] '.length));
      if (message.type !== 'assistant'
          || !['agentMessage', 'agent_message'].includes(message.codexItemType)) return;
      const text = (message.message?.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text).join('');
      const key = message.uuid ?? message.codexItemId ?? 'anonymous';
      const previous = messages.get(key)?.text ?? '';
      // The completed snapshot is authoritative even if it corrects a preview.
      messages.set(key, { text, phase: message.codexPhase });
      if (text.startsWith(previous) && text.length > previous.length) onDelta?.(text.slice(previous.length));
    },
  });
  service.on('codex_event', (event) => {
    if (event.kind !== 'interactionRequested') return;
    service.respondInteraction(event.payload.rpcId, declineInteraction(event.payload.method));
  });
  let timer;
  let cancel;
  try {
    const result = await Promise.race([
      service.send({
        input: [{ type: 'text', text: String(prompt ?? ''), text_elements: [] }],
        settings: {
          cwd, cwdExplicit: true, model: model || undefined, ephemeral: true,
          ...(effort ? { effort } : {}),
          approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
          developerInstructions: [developerInstructions, 'Return only the requested text. Do not run tools or ask for user input.']
            .filter(Boolean).join('\n\n'),
        },
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new ClassifiedError('CODEX_TEXT_TIMEOUT', 'Codex text request timed out')), timeoutMs);
      }),
      ...(signal ? [new Promise((_resolve, reject) => {
        cancel = () => reject(new ClassifiedError('CODEX_TEXT_CANCELLED', 'Codex text request cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      })] : []),
    ]);
    if (result.outcome !== 'completed') {
      throw new ClassifiedError('CODEX_TEXT_FAILED', result.error || `Codex text request ${result.outcome}`);
    }
    const values = [...messages.values()];
    const finalMessages = values.filter((message) => message.phase === 'final_answer');
    const text = (finalMessages.length ? finalMessages : values).map((message) => message.text).join('\n').trim()
      || anonymousText.trim();
    if (!text) throw new ClassifiedError('CODEX_TEXT_EMPTY', 'Codex text response is empty');
    return text;
  } finally {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener('abort', cancel);
    // Auxiliary entry points exit after returning; wait for the actual native
    // child to exit so process.exit cannot leave an orphan app-server behind.
    await service.resetRuntime({ reason: 'text-request-finished' });
  }
}
