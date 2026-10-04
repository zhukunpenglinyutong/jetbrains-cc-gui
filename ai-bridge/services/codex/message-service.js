/**
 * Codex Message Service — Slim Coordinator
 *
 * Handles message sending through Codex app-server with SDK fallback.
 * Provides unified interface that matches Claude's message service.
 *
 * Key Differences from Claude:
 * - Uses threadId instead of sessionId
 * - Permission model: skipGitRepoCheck + sandbox + approvalPolicy + native reviewer config
 * - Events: thread.*, turn.*, item.* (not system/assistant/user/result)
 * - Supports images via local_image type (requires file paths)
 *
 * All event-processing logic lives in codex-event-handler.js.
 * Utility functions are split across codex-utils.js, codex-agents-loader.js,
 * codex-patch-parser.js, and codex-command-utils.js.
 *
 * @author Crafted with geek spirit
 */

import { CodexPermissionMapper } from '../../utils/permission-mapper.js';
import { getMcpServerTools as getMcpServerToolsImpl } from '../claude/mcp-status/index.js';
import {
  logDebug, logInfo, logWarn,
  ensureCodexSdk,
  normalizeCodexPermissionMode,
  resolveSandboxModeOverride,
  resolveApprovalPolicyOverride,
  buildCodexCliEnvironment,
  applyCodexApprovalsReviewerConfig,
  isCodexNativeAutoReviewSupported,
  CODEX_NATIVE_AUTO_REVIEW_MIN_VERSION,
  buildErrorPayload
} from './codex-utils.js';
import { getInstalledSdkVersion } from '../../utils/sdk-loader.js';
import { collectAgentsInstructions } from './codex-agents-loader.js';
import { CodexAppServerClient } from './codex-appserver-client.js';
import { requestAskUserQuestionAnswers, requestPermissionFromJava } from '../../permission-ipc.js';
import {
  createInitialEventState,
  prepareSessionReplayBoundary,
  processCodexEventStream,
} from './codex-event-handler.js';

// Codex CLI rejects empty stdin even when --image is present.
const EMPTY_PROMPT_SENTINEL = '\u2063';

export function buildCodexRunInput(message, attachments = []) {
  const text = typeof message === 'string' ? message : '';
  const imageInputs = Array.isArray(attachments)
    ? attachments
        .filter((attachment) => attachment?.type === 'local_image' && attachment.path)
        .map((attachment) => ({ type: 'local_image', path: attachment.path }))
    : [];

  if (imageInputs.length === 0) {
    return text;
  }

  return [
    { type: 'text', text: text.trim() ? text : EMPTY_PROMPT_SENTINEL },
    ...imageInputs,
  ];
}

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

/**
 * Send message to Codex (with optional thread resumption)
 *
 * @param {string} message - User message to send
 * @param {string} threadId - Thread ID to resume (optional)
 * @param {string} cwd - Working directory (optional)
 * @param {string} permissionMode - Unified permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {string} baseUrl - API base URL (optional, for custom endpoints)
 * @param {string} apiKey - API key (optional, for custom auth)
 * @param {string} reasoningEffort - Reasoning effort level (optional)
 * @param {string} serviceTier - Codex service tier; "fast" matches Codex CLI /fast (optional)
 * @param {Array} attachments - Image attachments in local_image format (optional)
 */
async function sendMessageWithSdk(
  message,
  threadId = null,
  cwd = null,
  permissionMode = null,
  model = null,
  baseUrl = null,
  apiKey = null,
  reasoningEffort = 'medium',
  serviceTier = null,
  attachments = []
) {
  let streamStarted = false;
  let streamEnded = false;
  const emitStreamEndOnce = () => {
    if (!streamStarted || streamEnded) {
      return;
    }
    streamEnded = true;
    console.log('[STREAM_END]');
  };

  try {
    const normalizedPermissionMode = normalizeCodexPermissionMode(permissionMode || 'default');

    console.log('[DEBUG] Codex sendMessage called with params:', {
      threadId,
      cwd,
      permissionMode: normalizedPermissionMode,
      model,
      reasoningEffort,
      serviceTier,
      hasBaseUrl: !!baseUrl,
      hasApiKey: !!apiKey,
      attachmentsCount: attachments?.length || 0
    });

    console.log('[MESSAGE_START]');

    // ============================================================
    // 1. Initialize Codex SDK (dynamic loading)
    // ============================================================

    const sdk = await ensureCodexSdk();
    const Codex = sdk.Codex || sdk.default || sdk;

    if (normalizedPermissionMode === 'auto') {
      const installedVersion = getInstalledSdkVersion('codex-sdk');
      if (!isCodexNativeAutoReviewSupported(installedVersion)) {
        throw new Error(
          `Codex native auto review requires @openai/codex-sdk >= ${CODEX_NATIVE_AUTO_REVIEW_MIN_VERSION}`
          + ` (installed: ${installedVersion || 'unknown'}). Please update it in Settings > Dependencies.`
        );
      }
    }

    const codexOptions = {};

    // Always initialize config with reasoning summaries forced to true
    // so custom models not in the SDK's known-reasoning-model allowlist
    // still get thinking/reasoning parameters in API requests.
    codexOptions.config = {
      model_supports_reasoning_summaries: true
    };

    if (baseUrl) {
      codexOptions.baseUrl = baseUrl;
    }
    if (apiKey) {
      codexOptions.apiKey = apiKey;
    }
    if (serviceTier && serviceTier.trim() !== '') {
      const sdkServiceTier = serviceTier.trim();
      codexOptions.config = {
        ...codexOptions.config,
        features: {
          fast_mode: true
        },
        service_tier: sdkServiceTier
      };
      logDebug('Codex', 'Service tier:', sdkServiceTier, 'with fast_mode feature enabled');
    }

    // Pass a sanitized env to the SDK to avoid inherited CODEX_* pollution
    const { cliEnv, removedKeys } = buildCodexCliEnvironment(process.env);
    codexOptions.env = cliEnv;
    logDebug('PERM_DEBUG', 'Codex CLI env isolation:', JSON.stringify({
      removedKeys,
      removedCount: removedKeys.length
    }));

    // ============================================================
    // 2. Map Unified Permission Mode to Codex Format
    // ============================================================

    const permissionConfig = CodexPermissionMapper.toProvider(normalizedPermissionMode);

    logDebug('PERM_DEBUG', 'Codex permission config:', JSON.stringify(permissionConfig));
    logDebug('PERM_DEBUG', 'Raw env permission overrides:', JSON.stringify({
      CODEX_SANDBOX_MODE: process.env.CODEX_SANDBOX_MODE || '',
      CODEX_APPROVAL_POLICY: process.env.CODEX_APPROVAL_POLICY || ''
    }));

    const isNativeAutoReview = normalizedPermissionMode === 'auto';
    const sandboxOverride = resolveSandboxModeOverride();
    if (sandboxOverride && !isNativeAutoReview) {
      permissionConfig.sandbox = sandboxOverride;
      logDebug('PERM_DEBUG', 'Sandbox override from env CODEX_SANDBOX_MODE:', sandboxOverride);
    } else if (sandboxOverride && isNativeAutoReview) {
      logDebug('PERM_DEBUG', 'Ignoring sandbox override for native auto review:', sandboxOverride);
    }
    const approvalPolicyOverride = resolveApprovalPolicyOverride();
    if (approvalPolicyOverride && !isNativeAutoReview) {
      permissionConfig.approvalPolicy = approvalPolicyOverride;
      logDebug('PERM_DEBUG', 'Approval override from env CODEX_APPROVAL_POLICY:', approvalPolicyOverride);
    } else if (approvalPolicyOverride && isNativeAutoReview) {
      logDebug('PERM_DEBUG', 'Ignoring approval override for native auto review:', approvalPolicyOverride);
    }

    if (isNativeAutoReview) {
      permissionConfig.sandbox = 'workspace-write';
      permissionConfig.approvalPolicy = 'on-request';
    }

    applyCodexApprovalsReviewerConfig(codexOptions, permissionConfig);
    const codex = new Codex(codexOptions);

    // ============================================================
    // 3. Build Thread Options
    // ============================================================

    const threadOptions = {
      skipGitRepoCheck: permissionConfig.skipGitRepoCheck,
      maxTurns: 200
    };

    if (reasoningEffort && reasoningEffort.trim() !== '') {
      threadOptions.modelReasoningEffort = reasoningEffort;
      console.log('[DEBUG] Reasoning effort:', reasoningEffort);
    }

    if (permissionConfig.approvalPolicy) {
      threadOptions.approvalPolicy = permissionConfig.approvalPolicy;
    }

    // CRITICAL: Only set working directory for NEW threads
    const isResumingThread = threadId && threadId.trim() !== '';

    if (!isResumingThread) {
      if (cwd && cwd.trim() !== '') {
        threadOptions.workingDirectory = cwd;
        console.log('[DEBUG] Working directory:', cwd);
      }
    } else {
      console.log('[DEBUG] Resuming thread - skipping workingDirectory to allow session lookup');
    }

    if (model && model.trim() !== '') {
      threadOptions.model = model;
      console.log('[DEBUG] Model:', model);
    }

    if (permissionConfig.sandbox) {
      threadOptions.sandboxMode = permissionConfig.sandbox;
      console.log('[DEBUG] Sandbox mode:', permissionConfig.sandbox);
    }

    logDebug('PERM_DEBUG', 'Final Codex threadOptions:', JSON.stringify({
      permissionMode: normalizedPermissionMode,
      workingDirectory: threadOptions.workingDirectory,
      sandboxMode: threadOptions.sandboxMode,
      approvalPolicy: threadOptions.approvalPolicy,
      skipGitRepoCheck: threadOptions.skipGitRepoCheck
    }));

    // ============================================================
    // 4. Create or Resume Thread
    // ============================================================

    let thread;
    if (isResumingThread) {
      console.log('[DEBUG] Resuming thread:', threadId);
      thread = codex.resumeThread(threadId, threadOptions);
    } else {
      console.log('[DEBUG] Starting new thread');
      thread = codex.startThread(threadOptions);
    }

    // ============================================================
    // 5. Collect AGENTS.md Instructions (only for new threads)
    // ============================================================

    let finalMessage = message;
    if (!isResumingThread && cwd) {
      const agentsInstructions = collectAgentsInstructions(cwd);
      if (agentsInstructions) {
        finalMessage = `<agents-instructions>\n${agentsInstructions}\n</agents-instructions>\n\n${message}`;
        logDebug('AGENTS.md', `Prepended ${agentsInstructions.length} chars of instructions to message`);
      }
    }

    // ============================================================
    // 6. Build Input and Start Streaming
    // ============================================================

    const runInput = buildCodexRunInput(finalMessage, attachments);
    if (Array.isArray(runInput)) {
      for (const item of runInput) {
        if (item.type === 'local_image') {
          console.log('[DEBUG] Added local_image attachment:', item.path);
        }
      }
      console.log('[DEBUG] Using array input format with', runInput.length, 'entries');
    } else {
      console.log('[DEBUG] Using string input format');
    }

    const workingDirectory = cwd && cwd.trim() !== '' ? cwd : undefined;
    const emitMessage = (msg) => {
      console.log('[MESSAGE]', JSON.stringify(msg));
    };
    const state = createInitialEventState(emitMessage);
    await prepareSessionReplayBoundary(state, threadId);

    const turnAbortController = new AbortController();
    const { events } = await thread.runStreamed(runInput, {
      signal: turnAbortController.signal
    });
    console.log('[STREAM_START]');
    streamStarted = true;

    // ============================================================
    // 7. Delegate Event Processing to codex-event-handler
    // ============================================================

    const config = {
      cwd: workingDirectory,
      threadId,
      threadOptions,
      normalizedPermissionMode,
      turnAbortController,
      onTurnCompleted: emitStreamEndOnce,
      onTurnFailed: emitStreamEndOnce
    };

    await processCodexEventStream(events, state, config);
    emitStreamEndOnce();

    // ============================================================
    // 8. Completion Phase
    // ============================================================

    if (!state.reasoningObserved) {
      console.warn('[THINKING_HINT]', 'Codex did not return reasoning items. If you still cannot see the thinking process, please refer to docs/codex/docs/config.md for hide_agent_reasoning/show_raw_agent_reasoning settings, and ensure your OpenAI account has been verified.');
    }

    if (!state.suppressNoResponseFallback && state.assistantText.length === 0) {
      const noResponseMsg = [
        '\n[WARNING] Codex completed tool executions but did not generate a text response.',
        'This may happen when:',
        '- The task was purely about gathering information',
        '- Codex reached maxTurns limit (200 turns)',
        '- The query required only command execution',
        '\nPlease try:',
        '- Asking a more specific question',
        '- Requesting explicit analysis or explanation',
        '- Checking the command outputs above for your answer'
      ].join('\n');

      emitMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: noResponseMsg }]
        }
      });
      state.finalResponse = noResponseMsg;
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      threadId: state.currentThreadId,
      result: state.finalResponse
    }));

  } catch (error) {
    emitStreamEndOnce();
    console.error('[DEBUG] Error:', error.message);
    console.error('[DEBUG] Error stack:', error.stack);

    const errorPayload = buildErrorPayload(error);
    console.error('[SEND_ERROR]', JSON.stringify(errorPayload));
    console.log(JSON.stringify(errorPayload));
  }
}

export function normalizeAppServerInput(runInput) {
  const input = Array.isArray(runInput) ? runInput : [{ type: 'text', text: runInput }];
  return input.map((item) => item?.type === 'local_image' ? { ...item, type: 'localImage' } : item);
}

function normalizeAppServerItem(item) {
  if (!item || typeof item !== 'object') return item;

  const typeMap = {
    agentMessage: 'agent_message',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    webSearch: 'web_search',
    todoList: 'todo_list',
  };
  const normalized = { ...item, type: typeMap[item.type] || item.type };

  if (item.aggregatedOutput !== undefined) normalized.aggregated_output = item.aggregatedOutput;
  if (item.exitCode !== undefined) normalized.exit_code = item.exitCode;
  if (item.isError !== undefined) normalized.is_error = item.isError;
  if (item.structuredContent !== undefined && item.result?.structured_content === undefined) {
    normalized.structured_content = item.structuredContent;
  }
  if (item.result && item.result.structuredContent !== undefined) {
    normalized.result = { ...item.result, structured_content: item.result.structuredContent };
  }

  if (normalized.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    normalized.text = typeof item.text === 'string'
      ? item.text
      : summary.map((entry) => typeof entry === 'string' ? entry : entry?.text || '').filter(Boolean).join('\n');
  }
  return normalized;
}

function normalizeAppServerUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const map = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    input_tokens: map(usage.inputTokens ?? usage.input_tokens),
    cached_input_tokens: map(usage.cachedInputTokens ?? usage.cached_input_tokens),
    cache_write_input_tokens: map(usage.cacheWriteInputTokens ?? usage.cache_write_input_tokens),
    output_tokens: map(usage.outputTokens ?? usage.output_tokens),
    reasoning_output_tokens: map(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens),
    total_tokens: map(usage.totalTokens ?? usage.total_tokens),
  };
}

export async function* normalizeAppServerEvents(notifications, threadId) {
  yield { type: 'thread.started', thread_id: threadId };

  for await (const notification of notifications) {
    const { method, params = {} } = notification;
    switch (method) {
      case 'ccgui/sessionPoll':
        yield { type: 'session.poll' };
        break;
      case 'thread/started':
        break;
      case 'turn/started':
        yield { type: 'turn.started' };
        break;
      case 'item/started':
        yield { type: 'item.started', item: normalizeAppServerItem(params.item) };
        break;
      case 'item/updated':
        yield { type: 'item.updated', item: normalizeAppServerItem(params.item) };
        break;
      case 'item/agentMessage/delta':
        yield {
          type: 'item.agent_message_delta',
          item_id: params.itemId,
          thread_id: params.threadId,
          turn_id: params.turnId,
          delta: params.delta,
        };
        break;
      case 'item/completed':
        yield { type: 'item.completed', item: normalizeAppServerItem(params.item) };
        break;
      case 'thread/tokenUsage/updated': {
        const total = normalizeAppServerUsage(params.usage?.total);
        const last = normalizeAppServerUsage(params.usage?.last);
        yield {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              ...(total ? { total_token_usage: total } : {}),
              ...(last ? { last_token_usage: last } : {}),
              ...(params.usage?.modelContextWindow
                ? { model_context_window: params.usage.modelContextWindow }
                : {}),
            },
          },
        };
        break;
      }
      case 'turn/completed': {
        const usage = normalizeAppServerUsage(params.usage || params.turn?.usage);
        if (params.turn?.status === 'failed' || params.turn?.status === 'interrupted') {
          yield {
            type: 'turn.failed',
            error: params.turn.error || { message: `Turn ${params.turn.status}` },
          };
        } else {
          yield { type: 'turn.completed', ...(usage ? { usage } : {}) };
        }
        break;
      }
      case 'turn/failed':
        yield { type: 'turn.failed', error: params.turn?.error || params.error || { message: 'Turn failed' } };
        break;
      case 'error':
        yield { type: 'error', message: params.error?.message || params.message || 'Codex app-server error' };
        break;
      default:
        break;
    }
  }
}

function mapCodexAnswersToAppServer(questions, answers) {
  const rawAnswers = answers && typeof answers === 'object' ? answers : {};
  const result = {};
  for (const question of Array.isArray(questions) ? questions : []) {
    const questionId = typeof question?.id === 'string' ? question.id : '';
    const questionText = typeof question?.question === 'string' ? question.question : '';
    if (!questionId) continue;
    const value = rawAnswers[questionId] ?? rawAnswers[questionText];
    if (value === undefined || value === null || value === '') {
      result[questionId] = { answers: [] };
      continue;
    }
    result[questionId] = { answers: Array.isArray(value) ? value.map(String) : [String(value)] };
  }
  return result;
}

export function normalizeQuestionsForDialog(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map((question, index) => {
      if (!question || typeof question !== 'object') return null;
      const questionText = typeof question.question === 'string'
        ? question.question
        : typeof question.title === 'string' ? question.title : '';
      if (!questionText) return null;
      const options = Array.isArray(question.options)
        ? question.options.map((option) => typeof option === 'string'
          ? { label: option, description: '' }
          : option)
        : [];
      return {
        id: typeof question.id === 'string' ? question.id : `question-${index + 1}`,
        question: questionText,
        header: typeof question.header === 'string' ? question.header : '',
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter(Boolean);
}

const codexUserInputTool = {
  type: 'function',
  name: 'cc_gui_request_user_input',
  description: 'Open the CC GUI question dialog and wait for the user answer before continuing.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            question: { type: 'string' },
            header: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            multiSelect: { type: 'boolean' },
          },
          required: ['title', 'options'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

export function buildDynamicUserInputResult(questions, answers) {
  const mappedAnswers = {};
  const rawAnswers = answers && typeof answers === 'object' ? answers : {};
  for (const question of questions) {
    const value = rawAnswers[question.id] ?? rawAnswers[question.question];
    const selected = value === undefined || value === null || value === ''
      ? []
      : Array.isArray(value) ? value.map(String) : [String(value)];
    mappedAnswers[question.question] = question.multiSelect ? selected : selected[0] || '';
  }
  return {
    success: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify({ answers: mappedAnswers }) }],
  };
}

export function createAsyncUserInputBridge(client, threadId, pendingInputs, ask = requestAskUserQuestionAnswers) {
  const questionAnswers = new Map();
  return async (argumentsValue, callId) => {
    const questions = normalizeQuestionsForDialog(argumentsValue.questions);
    if (questions.length === 0) return;
    console.info(`[CODEX_USER_INPUT] Async request received: ${callId}, questions=${questions.length}`);
    const questionKey = JSON.stringify(questions);
    let answerPromise = questionAnswers.get(questionKey);
    if (!answerPromise) {
      answerPromise = Promise.resolve().then(() => ask({ provider: 'codex', toolName: 'request_user_input_async', questions }));
      questionAnswers.set(questionKey, answerPromise);
    } else {
      console.info(`[CODEX_USER_INPUT] Reusing identical question response: ${callId}`);
    }
    const answers = await answerPromise;
    const result = buildDynamicUserInputResult(questions, answers);
    const response = JSON.parse(result.contentItems[0].text);
    const hasAnswers = Object.values(response.answers)
      .some((answer) => Array.isArray(answer) ? answer.length > 0 : answer !== '');
    const input = [{
      type: 'text',
      text: JSON.stringify({
        type: 'user_input_response',
        call_id: callId,
        ...response,
        ...(hasAnswers ? {} : { cancelled: true }),
      }),
    }];
    try {
      if (!client.activeTurnId) {
        pendingInputs.push(...input);
        return;
      }
      await client.steerTurn(threadId, client.activeTurnId, input);
      console.info(`[CODEX_USER_INPUT] Async answer delivered: ${callId}`);
    } catch (error) {
      if (error?.code !== -32600 || !/no active turn|not active|turn.*(completed|mismatch)|expected.*turn/i.test(error.message)) {
        throw error;
      }
      pendingInputs.push(...input);
      console.info(`[CODEX_USER_INPUT] Async answer queued after turn completion: ${callId}`);
    }
  };
}

function parseDynamicToolArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export async function handleCodexReverseRequest(method, params, permissionMode = 'default') {
  if (method === 'item/tool/requestUserInput') {
    const questions = normalizeQuestionsForDialog(params.questions);
    console.info(`[CODEX_USER_INPUT] Opening dialog for ${questions.length} question(s)`);
    const answers = await requestAskUserQuestionAnswers({
      provider: 'codex',
      toolName: 'request_user_input',
      questions,
    });
    console.info(`[CODEX_USER_INPUT] Dialog completed: ${answers ? 'answered' : 'empty or unavailable'}`);
    return { answers: mapCodexAnswersToAppServer(params.questions, answers) };
  }

  if (method === 'item/tool/call' && params.tool === codexUserInputTool.name) {
    const toolArguments = parseDynamicToolArguments(params.arguments);
    const questions = normalizeQuestionsForDialog(toolArguments.questions);
    console.info(`[CODEX_USER_INPUT] Dynamic tool call received for ${questions.length} question(s)`);
    const answers = await requestAskUserQuestionAnswers({
      provider: 'codex',
      toolName: 'request_user_input',
      questions,
    });
    console.info(`[CODEX_USER_INPUT] Dynamic tool completed: ${answers ? 'answered' : 'empty or unavailable'}`);
    return buildDynamicUserInputResult(questions, answers);
  }

  if (method === 'item/commandExecution/requestApproval') {
    const command = typeof params.command === 'string' ? params.command : '';
    const allowed = await requestPermissionFromJava('Bash', {
      command,
      description: params.reason || command,
      source: 'codex_command_execution',
    });
    return { decision: allowed ? 'accept' : 'decline' };
  }

  if (method === 'item/fileChange/requestApproval') {
    if (permissionMode === 'acceptEdits') {
      return { decision: 'accept' };
    }
    const allowed = await requestPermissionFromJava('Write', {
      changes: params,
      source: 'codex_file_change',
    });
    return { decision: allowed ? 'accept' : 'decline' };
  }

  const error = new Error(`Unsupported Codex app-server request: ${method}`);
  error.code = -32601;
  throw error;
}

async function sendMessageWithAppServer(
  message,
  threadId = null,
  cwd = null,
  permissionMode = null,
  model = null,
  baseUrl = null,
  apiKey = null,
  reasoningEffort = 'medium',
  serviceTier = null,
  attachments = []
) {
  let streamStarted = false;
  let messageStarted = false;
  let streamEnded = false;
  const emitStreamEndOnce = () => {
    if (!streamStarted || streamEnded) return;
    streamEnded = true;
    console.log('[STREAM_END]');
  };

  const normalizedPermissionMode = normalizeCodexPermissionMode(permissionMode || 'default');
  if (normalizedPermissionMode === 'auto') {
    const installedVersion = getInstalledSdkVersion('codex-sdk');
    if (!isCodexNativeAutoReviewSupported(installedVersion)) {
      throw new Error(
        `Codex native auto review requires @openai/codex-sdk >= ${CODEX_NATIVE_AUTO_REVIEW_MIN_VERSION}`
        + ` (installed: ${installedVersion || 'unknown'}). Please update it in Settings > Dependencies.`
      );
    }
  }

  const permissionConfig = CodexPermissionMapper.toProvider(normalizedPermissionMode);
  const { cliEnv } = buildCodexCliEnvironment(process.env);
  const isResumingThread = typeof threadId === 'string' && threadId.trim() !== '';
  const threadOptions = {
    approvalPolicy: permissionConfig.approvalPolicy,
    sandboxMode: permissionConfig.sandbox,
  };
  const client = new CodexAppServerClient({
    cwd: cwd || undefined,
    env: cliEnv,
    baseUrl,
    apiKey,
    onReverseRequest: (method, params) => handleCodexReverseRequest(method, params, normalizedPermissionMode),
  });

  try {
    console.info('[CODEX_APP_SERVER] Starting Codex app-server transport');
    await client.initialize();
    const commonParams = {
      ...(model ? { model } : {}),
      ...(permissionConfig.approvalPolicy ? { approvalPolicy: permissionConfig.approvalPolicy } : {}),
      approvalsReviewer: permissionConfig.approvalsReviewer || 'user',
      ...(permissionConfig.sandbox ? { sandbox: permissionConfig.sandbox } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      config: { model_supports_reasoning_summaries: true },
    };
    const threadResult = isResumingThread
      ? await client.resumeThread({ threadId, ...commonParams })
      : await client.startThread({
        ...commonParams,
        dynamicTools: [codexUserInputTool],
        ...(cwd ? { cwd } : {}),
        threadSource: 'cc-gui',
      });
    const activeThreadId = threadResult?.thread?.id || threadId;
    if (!activeThreadId) throw new Error('Codex app-server did not return a thread id');

    let finalMessage = message;
    if (!isResumingThread && cwd) {
      const agentsInstructions = collectAgentsInstructions(cwd);
      if (agentsInstructions) {
        finalMessage = `<agents-instructions>\n${agentsInstructions}\n</agents-instructions>\n\n${message}`;
      }
    }
    const runInput = normalizeAppServerInput(buildCodexRunInput(finalMessage, attachments));
    const workingDirectory = cwd && cwd.trim() !== '' ? cwd : undefined;
    const emitMessage = (msg) => console.log('[MESSAGE]', JSON.stringify(msg));
    const state = createInitialEventState(emitMessage);
    await prepareSessionReplayBoundary(state, isResumingThread ? activeThreadId : null);
    const turnAbortController = new AbortController();
    const pendingUserInputs = [];
    const config = {
      cwd: workingDirectory,
      threadId: activeThreadId,
      threadOptions,
      normalizedPermissionMode,
      turnAbortController,
      appServerTransport: true,
      onTurnFailed: emitStreamEndOnce,
    };

    console.log('[MESSAGE_START]');
    messageStarted = true;
    console.log('[STREAM_START]');
    streamStarted = true;
    let nextInput = runInput;
    do {
      config.onAsyncUserInput = createAsyncUserInputBridge(client, activeThreadId, pendingUserInputs);
      const rawNotifications = client.streamTurn(activeThreadId, nextInput, {
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        ...(serviceTier ? { serviceTierForTurn: serviceTier } : {}),
      });
      await processCodexEventStream(normalizeAppServerEvents(rawNotifications, activeThreadId), state, config);
      nextInput = pendingUserInputs.splice(0);
      if (nextInput.length > 0) await prepareSessionReplayBoundary(state, activeThreadId);
    } while (nextInput.length > 0);
    emitStreamEndOnce();

    if (!state.reasoningObserved) {
      console.warn('[THINKING_HINT]', 'Codex did not return reasoning items.');
    }
    if (!state.suppressNoResponseFallback && state.assistantText.length === 0) {
      const noResponseMsg = [
        '\n[WARNING] Codex completed tool executions but did not generate a text response.',
        'Please try asking for an explicit explanation or response.',
      ].join('\n');
      emitMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: noResponseMsg }] },
      });
      state.finalResponse = noResponseMsg;
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({ success: true, threadId: state.currentThreadId, result: state.finalResponse }));
  } catch (error) {
    if (!messageStarted) throw error;
    emitStreamEndOnce();
    console.error('[DEBUG] Codex app-server error:', error.message);
    console.error('[SEND_ERROR]', JSON.stringify(buildErrorPayload(error)));
    console.log(JSON.stringify(buildErrorPayload(error)));
  } finally {
    client.close();
  }
}

/**
 * Send a Codex message. The app-server transport is preferred because the
 * TypeScript SDK's exec JSONL stream cannot receive reverse user-input calls.
 * If app-server is unavailable before a turn starts, retain SDK compatibility.
 */
export async function sendMessage(...args) {
  try {
    await sendMessageWithAppServer(...args);
  } catch (error) {
    logWarn('CODEX_APP_SERVER', `Falling back to Codex SDK transport: ${error?.message || error}`);
    await sendMessageWithSdk(...args);
  }
}

// ---------------------------------------------------------------------------
// getMcpServerTools
// ---------------------------------------------------------------------------

/**
 * Gets the tools list for a Codex MCP server.
 * Reuses mcp-status-service probing logic to avoid duplicate handshake implementation.
 *
 * @param {string} serverId
 * @param {Object} rawServerConfig
 */
export async function getMcpServerTools(serverId, rawServerConfig) {
  try {
    if (!serverId) {
      const invalid = {
        success: false,
        serverId: '',
        error: 'Missing serverId',
        tools: []
      };
      console.log('[MCP_SERVER_TOOLS]' + JSON.stringify(invalid));
      console.log(JSON.stringify(invalid));
      return;
    }

    if (!rawServerConfig || typeof rawServerConfig !== 'object') {
      const invalid = {
        success: false,
        serverId,
        error: 'Missing serverConfig',
        tools: []
      };
      console.log('[MCP_SERVER_TOOLS]' + JSON.stringify(invalid));
      console.log(JSON.stringify(invalid));
      return;
    }

    const serverConfig = normalizeCodexMcpConfig(rawServerConfig);
    const toolsResult = await getMcpServerToolsImpl(serverId, serverConfig);
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
    const hasError = !!toolsResult?.error;

    const result = {
      success: !hasError || tools.length > 0,
      serverId,
      serverName: toolsResult?.name || serverId,
      tools,
      error: toolsResult?.error || null
    };

    const resultJson = JSON.stringify(result);
    console.log('[MCP_SERVER_TOOLS]' + resultJson);
    console.log(resultJson);
  } catch (error) {
    const errorResult = {
      success: false,
      serverId: serverId || '',
      error: error?.message || String(error),
      tools: []
    };
    const resultJson = JSON.stringify(errorResult);
    console.log('[MCP_SERVER_TOOLS]' + resultJson);
    console.log(resultJson);
  }
}

// ---------------------------------------------------------------------------
// normalizeCodexMcpConfig (internal)
// ---------------------------------------------------------------------------

/**
 * Converts Codex config field names to a format recognized by mcp-status-service.
 *
 * @param {Object} raw
 * @returns {Object}
 */
function normalizeCodexMcpConfig(raw) {
  const normalized = { ...raw };
  const type = normalized.type || (normalized.url ? 'http' : 'stdio');
  normalized.type = type;

  // Codex: http_headers -> mcp-status: headers
  if (!normalized.headers && normalized.http_headers && typeof normalized.http_headers === 'object') {
    normalized.headers = { ...normalized.http_headers };
  }

  // Codex: env_http_headers (values are env var names) -> headers (resolved values)
  if (normalized.env_http_headers && typeof normalized.env_http_headers === 'object') {
    const fromEnv = {};
    for (const [headerName, envName] of Object.entries(normalized.env_http_headers)) {
      if (typeof envName === 'string') {
        const envValue = process.env[envName];
        if (envValue) {
          fromEnv[headerName] = envValue;
        }
      }
    }
    normalized.headers = { ...(normalized.headers || {}), ...fromEnv };
  }

  // Codex: bearer_token_env_var -> Authorization header
  if (normalized.bearer_token_env_var && typeof normalized.bearer_token_env_var === 'string') {
    const token = process.env[normalized.bearer_token_env_var];
    if (token && !(normalized.headers && normalized.headers.Authorization)) {
      normalized.headers = { ...(normalized.headers || {}), Authorization: `Bearer ${token}` };
    }
  }

  return normalized;
}
