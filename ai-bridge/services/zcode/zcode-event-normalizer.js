/**
 * ZCode session/event → marker-stream normalizer.
 *
 * Consumes `session/event` notifications from the app-server and emits the
 * canonical marker vocabulary that BaseSDKBridge/MarkerCliBridge parse:
 *   [MESSAGE_START] [STREAM_START] [CONTENT_DELTA] [THINKING_DELTA]
 *   [MESSAGE] (Claude-shaped tool_use) [TOOL_RESULT] [BLOCK_RESET]
 *   [USAGE] (snake_case) [STREAM_END] [MESSAGE_END] [SEND_ERROR]
 *
 * Tool calls arrive on two channels that must be merged per toolCallId:
 * `model.streaming` carries tool_input_start/delta/end (input accumulation),
 * `tool.updated` carries scheduled/started/result/error (execution lifecycle).
 */

function camelUsageToSnake(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  const map = {
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    totalTokens: 'total_tokens',
    cacheReadTokens: 'cache_read_input_tokens',
    cacheWriteTokens: 'cache_creation_input_tokens',
    modelRequestCount: 'model_request_count',
  };
  for (const [from, to] of Object.entries(map)) {
    if (typeof usage[from] === 'number') out[to] = usage[from];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function stringifyToolContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export class ZcodeEventNormalizer {
  /**
   * @param {(line: string) => void} emit   stdout marker sink
   * @param {(line: string) => void} [error] stderr/diagnostic sink
   */
  constructor(emit, error = () => {}) {
    this.emit = emit;
    this.error = error;
    this.reset();
  }

  reset() {
    this.turnId = null;
    this.turnOpen = false;
    this.toolCalls = new Map(); // toolCallId -> {name, inputText, input, emittedUse, emittedResult}
  }

  /**
   * Handle one session/event notification payload.
   * @param {object} event envelope {type, sessionId, turnId, payload}
   * @returns {'completed'|'failed'|null} terminal marker for the active turn
   */
  handleSessionEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};

    switch (event.type) {
      case 'turn.started':
        this.turnId = event.turnId || null;
        this.turnOpen = true;
        this.toolCalls.clear();
        this.emit('[MESSAGE_START]');
        this.emit('[STREAM_START]');
        return null;

      case 'model.streaming':
        this.#handleStreaming(payload);
        return null;

      case 'tool.updated':
        this.#handleToolUpdated(payload);
        return null;

      case 'turn.completed': {
        const usage = camelUsageToSnake(payload.usage);
        if (usage) this.emit(`[USAGE] ${JSON.stringify(usage)}`);
        this.#finishTurn(true);
        return 'completed';
      }

      case 'turn.failed': {
        const err = payload.error && typeof payload.error === 'object' ? payload.error : {};
        const message = err.message || 'ZCode turn failed';
        this.#settleAllTools(false);
        this.emit(`[SEND_ERROR] ${JSON.stringify({ success: false, error: message })}`);
        this.#finishTurn(false);
        return 'failed';
      }

      default:
        return null;
    }
  }

  #handleStreaming(payload) {
    switch (payload.kind) {
      case 'text_delta':
        if (payload.delta) this.emit(`[CONTENT_DELTA] ${JSON.stringify(String(payload.delta))}`);
        break;
      case 'reasoning_delta':
        if (payload.delta) this.emit(`[THINKING_DELTA] ${JSON.stringify(String(payload.delta))}`);
        break;
      case 'tool_input_start': {
        if (!payload.toolCallId) break;
        this.toolCalls.set(payload.toolCallId, {
          name: payload.toolName || 'tool',
          inputText: '',
          input: null,
          emittedUse: false,
          emittedResult: false,
        });
        break;
      }
      case 'tool_input_delta': {
        const tc = this.toolCalls.get(payload.toolCallId);
        if (tc && payload.delta) tc.inputText += String(payload.delta);
        break;
      }
      case 'tool_input_end': {
        const tc = this.toolCalls.get(payload.toolCallId);
        if (tc) tc.input = this.#parseInputText(tc.inputText);
        break;
      }
      case 'tool_call': {
        if (!payload.toolCallId) break;
        const tc = this.toolCalls.get(payload.toolCallId) || {
          inputText: '', input: null, emittedUse: false, emittedResult: false,
        };
        tc.name = payload.toolName || tc.name || 'tool';
        if (payload.input && typeof payload.input === 'object') tc.input = payload.input;
        this.toolCalls.set(payload.toolCallId, tc);
        break;
      }
      default:
        break;
    }
  }

  #handleToolUpdated(payload) {
    if (!payload.toolCallId) return;
    const tc = this.toolCalls.get(payload.toolCallId) || {
      inputText: '', input: null, emittedUse: false, emittedResult: false,
    };
    if (payload.toolName) tc.name = payload.toolName;
    if (payload.input && typeof payload.input === 'object') tc.input = payload.input;
    this.toolCalls.set(payload.toolCallId, tc);

    switch (payload.kind) {
      case 'started':
        // Emit the tool_use block as soon as the input is known so the UI can
        // render the tool card while the tool runs.
        if (tc.input) this.#emitToolUse(payload.toolCallId, tc);
        break;
      case 'result': {
        this.#emitToolUse(payload.toolCallId, tc);
        const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
        this.#emitToolResult(payload.toolCallId, tc, {
          content: stringifyToolContent(result.content),
          isError: result.success === false,
        });
        break;
      }
      case 'error': {
        this.#emitToolUse(payload.toolCallId, tc);
        const err = payload.error && typeof payload.error === 'object' ? payload.error : null;
        this.#emitToolResult(payload.toolCallId, tc, {
          content: err ? (err.message || stringifyToolContent(err)) : 'tool failed',
          isError: true,
        });
        break;
      }
      default:
        // scheduled / progress / batch — no UI emission needed.
        break;
    }
  }

  #parseInputText(inputText) {
    if (!inputText) return null;
    try {
      const parsed = JSON.parse(inputText);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  #emitToolUse(toolCallId, tc) {
    if (tc.emittedUse) return;
    tc.emittedUse = true;
    const input = tc.input && typeof tc.input === 'object'
      ? tc.input
      : (this.#parseInputText(tc.inputText) || {});
    this.emit(`[MESSAGE] ${JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolCallId, name: tc.name || 'tool', input }],
      },
    })}`);
    this.emit('[BLOCK_RESET]');
  }

  #emitToolResult(toolCallId, tc, { content, isError }) {
    if (tc.emittedResult) return;
    tc.emittedResult = true;
    this.emit(`[TOOL_RESULT] ${JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolCallId,
      content,
      is_error: !!isError,
    })}`);
  }

  /** End-of-turn settlement for tool calls that never got a terminal frame. */
  #settleAllTools(success) {
    for (const [id, tc] of this.toolCalls) {
      if (!tc.emittedResult) {
        this.#emitToolUse(id, tc);
        this.#emitToolResult(id, tc, {
          content: success ? 'ok' : 'cancelled',
          isError: !success,
        });
      }
    }
  }

  #finishTurn(success) {
    if (success) this.#settleAllTools(true);
    if (this.turnOpen) {
      this.emit('[STREAM_END]');
      this.emit('[MESSAGE_END]');
      this.turnOpen = false;
    }
  }
}
