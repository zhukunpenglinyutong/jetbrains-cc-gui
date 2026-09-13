/**
 * Normalize Grok ACP events → Claude-compatible bridge protocol tags.
 *
 * Emits lines on stdout that GrokSDKBridge / ClaudeStreamAdapter-style parsers understand:
 *   [MESSAGE_START] [STREAM_START] [CONTENT_DELTA] [MESSAGE] [TOOL_RESULT]
 *   [THINKING_DELTA] [USAGE] [SESSION_ID] [STREAM_END] [MESSAGE_END] [SEND_ERROR]
 *
 * [USAGE] payloads are always snake_case (total_tokens/input_tokens/…) so Java
 * consumers can treat OpenAI shape as primary; camelCase ACP is normalized here.
 */

import { extractUsageFromAcpEnvelope, normalizeUsageToSnakeCase } from './grok-utils.js';

export class GrokEventNormalizer {
  constructor({ log = console.log, error = console.error } = {}) {
    this.log = log;
    this.error = error;
    this.assistantText = '';
    this.thinkingText = '';
    this.streamStarted = false;
    this.messageStarted = false;
    this.streamEnded = false;
    this.messageEnded = false;
    this.sessionId = null;
    /**
     * Per-turn file-edit ledger (toolCallId -> entry).
     * Grok streaming often never emits Claude-shaped tool_use; we bookkeep from
     * permission / tool_call / fs_write and flush at turn end so StatusPanel is accurate.
     */
    this.toolCalls = new Map();
    this.editSeq = 0;
    /** Last normalized snake_case usage for this turn (attached to final [MESSAGE]). */
    this.lastUsage = null;
  }

  begin() {
    this.toolCalls.clear();
    this.editSeq = 0;
    this.#emit('[MESSAGE_START]');
    this.messageStarted = true;
    this.#emit('[STREAM_START]');
    this.streamStarted = true;
  }

  handleAcpEvent(type, payload) {
    switch (type) {
      case 'session_id':
        this.sessionId = payload;
        this.#emit(`[SESSION_ID] ${payload}`);
        break;

      case 'notification':
        this.#handleNotification(payload?.method, payload?.params || {});
        break;

      case 'prompt_result':
        this.#handlePromptResult(payload);
        break;

      case 'server_request':
        this.#handleServerRequest(payload || {});
        break;

      case 'permission_decision':
        this.#handlePermissionDecision(payload || {});
        break;

      case 'fs_write':
        this.#recordFsWrite(payload || {});
        break;

      default:
        break;
    }
  }

  finishSuccess(sessionId, resultText) {
    const finalSessionId = sessionId || this.sessionId || `grok-${Date.now()}`;
    if (!this.sessionId) {
      this.#emit(`[SESSION_ID] ${finalSessionId}`);
    }

    // Turn-end settlement: emit any booked file edits that streaming never materialised.
    // This is what makes StatusPanel "编辑 +N -M" correct after Grok turns.
    this.#flushFileEditLedger({ assumeSuccess: true });

    const text = (resultText != null && String(resultText).length > 0)
      ? String(resultText)
      : this.assistantText;

    // Final assistant message block for history (Claude-like).
    // Attach lastUsage so Java message.usage survives even if a mid-turn [USAGE]
    // was overwritten by a later MESSAGE without usage.
    const assistantMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: this.#buildContentBlocks(text),
        ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      },
    };
    // Ensure [USAGE] is emitted at least once before stream ends (prompt _meta path).
    if (this.lastUsage) {
      this.#emit(`[USAGE] ${JSON.stringify(this.lastUsage)}`);
    }
    this.#emit(`[MESSAGE] ${JSON.stringify(assistantMessage)}`);

    this.#emitStreamEndOnce();
    this.#emitMessageEndOnce();

    this.log(
      JSON.stringify({
        success: true,
        sessionId: finalSessionId,
        result: text,
      })
    );
  }

  finishError(error) {
    // Still flush booked edits so a failed turn that already wrote files is
    // counted — but only entries with execution evidence (an observed fs_write
    // or an explicit permission allow). Pending entries (permission requested,
    // user never decided, turn died) must not be assumed successful.
    try {
      this.#flushFileEditLedger({ assumeSuccess: false });
    } catch {
      // ignore
    }
    this.#emitStreamEndOnce();
    this.#emitMessageEndOnce();

    const payload = {
      success: false,
      error: formatGrokError(error),
    };
    this.error(`[SEND_ERROR] ${JSON.stringify(payload)}`);
    this.log(JSON.stringify(payload));
  }

  #emitUsage(raw) {
    if (!raw) return;
    const usage = normalizeUsageToSnakeCase(raw) || raw;
    // Avoid empty {} spam
    if (!usage || (typeof usage === 'object' && !Object.keys(usage).length)) return;
    this.lastUsage = usage;
    this.#emit(`[USAGE] ${JSON.stringify(usage)}`);
  }

  #handleNotification(method, params) {
    // Grok CLI 0.2.x: usage arrives on _x.ai/session_notification (turn_completed),
    // not on classic sessionUpdate=usage_update.
    const fromEnvelope = extractUsageFromAcpEnvelope(method, params);
    if (fromEnvelope) {
      this.#emitUsage(fromEnvelope);
    }

    if (method !== 'session/update') {
      return;
    }
    const update = params?.update || params;
    if (!update) return;

    const kind = update.sessionUpdate || update.type || '';

    switch (kind) {
      case 'agent_message_chunk': {
        const text = extractText(update.content) || extractText(update.delta) || update.text || '';
        this.#emitChunk(text, 'content');
        break;
      }
      case 'agent_thought_chunk':
      case 'agent_thinking_chunk':
      case 'thought_chunk': {
        const text = extractText(update.content) || extractText(update.delta) || update.text || '';
        this.#emitChunk(text, 'thinking');
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        this.#handleToolUpdate(update);
        break;
      }
      case 'usage_update':
      case 'usage':
      case 'turn_completed': {
        // usage already emitted via extractUsageFromAcpEnvelope above when present
        break;
      }
      case 'user_message_chunk':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'plan':
        // ignore or future UI
        break;
      default: {
        // Try generic text fields
        const text = extractText(update.content) || extractText(update.delta) || update.text;
        if (text && kind.includes('message')) {
          this.#emitChunk(text, 'content');
        }
        break;
      }
    }
  }

  /**
   * Grok CLI often re-sends the full accumulated text so far (snapshot) instead
   * of just the new part. Derive the true delta against the accumulated text
   * for {@code target} ("content" | "thinking") and emit it as a
   * CONTENT_DELTA / THINKING_DELTA line — once, deduplicated.
   */
  #emitChunk(text, target) {
    if (!text) return;
    const isThinking = target === 'thinking';
    const acc = isThinking ? this.thinkingText : this.assistantText;
    let delta;
    let total;
    if (text.startsWith(acc)) {
      // Snapshot: text contains everything emitted so far plus the new part.
      delta = text.slice(acc.length);
      total = text;
    } else if (acc.startsWith(text)) {
      // Stale replay of an earlier snapshot — nothing new.
      delta = '';
      total = acc;
    } else {
      // Genuine delta.
      delta = text;
      total = acc + text;
    }
    if (isThinking) {
      this.thinkingText = total;
    } else {
      this.assistantText = total;
    }
    if (delta) {
      const tag = isThinking ? '[THINKING_DELTA]' : '[CONTENT_DELTA]';
      this.#emit(`${tag} ${JSON.stringify(delta)}`);
    }
  }

  #handleToolUpdate(update) {
    const toolCallId =
      update.toolCallId ||
      update.tool_call_id ||
      update.id ||
      update.toolUseId ||
      `tool-${Date.now()}`;
    const title = update.title || '';
    const kind = String(update.kind || update.toolKind || '').toLowerCase();
    const status = String(update.status || '').toLowerCase();
    const rawName = update.name || update.toolName || title || 'tool';
    const rawInput = update.rawInput || update.input || update.arguments || {};
    const rawOutput = update.rawOutput || update.output || update.result;
    const locations = update.locations || update.location || [];

    const name = normalizeEditToolName(rawName, kind, title);
    const input = normalizeEditToolInput(rawInput, locations);
    this.#bookFileEdit(toolCallId, {
      name,
      input,
      status,
      rawOutput,
      allowed: status === 'failed' || status === 'error' ? false : undefined,
    });

    const done = isTerminalToolStatus(status) || rawOutput != null;
    // Emit mid-stream when we already have usable edit payload (nice-to-have).
    // Turn-end flush still guarantees correctness if this is skipped.
    if (done || hasUsableEditPayload(input)) {
      this.#emitBookedEdit(toolCallId, { forceResult: done });
    }
  }

  /**
   * Live path (idea.log): Grok asks session/request_permission for Edit with
   * path/content, user allows, file is written — but no Claude tool_use arrives.
   * Book the edit here; flush at finishSuccess.
   */
  #handleServerRequest(payload) {
    const method = payload?.method || '';
    if (method) this.#emitStatus(`ACP request: ${method}`);
    if (!isPermissionMethod(method)) return;

    const info = extractPermissionEditInfo(
      payload?.params || {},
      // Unique ledger key when the permission params carry no toolCallId;
      // the shared editSeq counter avoids same-millisecond Date.now() key
      // collisions between concurrent permission requests.
      `perm-edit-${++this.editSeq}`,
    );
    if (!info) return;

    this.#bookFileEdit(info.toolCallId, {
      name: info.name,
      input: info.input,
      status: 'pending_permission',
      fromPermission: true,
    });
    // Mid-stream emit when payload is rich enough (UI can show Write card early)
    if (hasUsableEditPayload(info.input)) {
      this.#emitBookedEdit(info.toolCallId, { forceResult: false });
    }
  }

  #handlePermissionDecision(payload) {
    const allowed = payload?.allowed === true;
    let toolCallId =
      (typeof payload?.toolCallId === 'string' && payload.toolCallId) ||
      (typeof payload?.tool_call_id === 'string' && payload.tool_call_id) ||
      '';

    if (!toolCallId) {
      // Last pending permission-booked edit
      for (const [id, tc] of this.toolCalls.entries()) {
        if (tc.fromPermission && !tc.emittedResult) toolCallId = id;
      }
    }
    if (!toolCallId) return;

    const prev = this.toolCalls.get(toolCallId) || {};
    // Merge any input carried on the decision
    let input = prev.input || {};
    if (payload?.input && typeof payload.input === 'object') {
      input = normalizeEditToolInput({ ...input, ...payload.input }, payload.input?._acp?.locations || []);
    }
    this.#bookFileEdit(toolCallId, {
      name: prev.name || normalizeEditToolName(payload?.toolName || 'Edit', 'edit', ''),
      input,
      status: allowed ? 'completed' : 'failed',
      allowed,
      fromPermission: true,
    });
    this.#emitBookedEdit(toolCallId, { forceResult: true });
  }

  #recordFsWrite(payload) {
    const filePath =
      (typeof payload?.path === 'string' && payload.path) ||
      (typeof payload?.file_path === 'string' && payload.file_path) ||
      '';
    if (!filePath) return;
    const content = typeof payload.content === 'string' ? payload.content : String(payload.content ?? '');

    // Enrich existing booked edit for same path
    for (const [id, tc] of this.toolCalls.entries()) {
      if (toolPath(tc.input) === filePath) {
        const input = normalizeEditToolInput({ ...(tc.input || {}), path: filePath, content }, []);
        this.#bookFileEdit(id, {
          name: isFileEditTool(tc.name) ? tc.name : 'Write',
          input,
          status: 'completed',
          allowed: true,
          rawOutput: 'ok',
        });
        this.#emitBookedEdit(id, { forceResult: true });
        return;
      }
    }

    const id = `fs-write-${++this.editSeq}`;
    const input = normalizeEditToolInput({ path: filePath, content }, []);
    this.#bookFileEdit(id, {
      name: 'Write',
      input,
      status: 'completed',
      allowed: true,
      rawOutput: 'ok',
    });
    this.#emitBookedEdit(id, { forceResult: true });
  }

  #bookFileEdit(toolCallId, patch) {
    const prev = this.toolCalls.get(toolCallId) || {};
    const name = patch.name || prev.name || 'Edit';
    this.toolCalls.set(toolCallId, {
      ...prev,
      ...patch,
      name,
      input: patch.input ? preferRicher(prev.input, patch.input) : prev.input,
      // Never lose emission flags when patching mid-turn
      emittedUse: Boolean(prev.emittedUse || patch.emittedUse),
      emittedResult: Boolean(prev.emittedResult || patch.emittedResult),
    });
  }

  #emitBookedEdit(toolCallId, { forceResult = false } = {}) {
    const tc = this.toolCalls.get(toolCallId);
    if (!tc) return;
    if (!isFileEditTool(tc.name)) {
      // Non-file tools: keep legacy immediate emit behaviour for UI tool cards
      this.#emitLegacyToolIfNeeded(toolCallId, tc, forceResult);
      return;
    }

    const input = normalizeEditToolInput(tc.input || {}, []);
    if (!tc.emittedUse) {
      // Require at least a path so StatusPanel has a file entry
      if (!toolPath(input) && !forceResult) return;
      this.#emitToolUse(toolCallId, canonicalEditName(tc.name, input), input);
      this.toolCalls.set(toolCallId, {
        ...this.toolCalls.get(toolCallId),
        emittedUse: true,
        input,
      });
    }

    if (!forceResult) return;
    if (this.toolCalls.get(toolCallId)?.emittedResult) return;

    const failed =
      tc.allowed === false ||
      tc.status === 'failed' ||
      tc.status === 'error' ||
      tc.status === 'cancelled' ||
      tc.status === 'canceled';
    const rawOut = tc.rawOutput;
    const content =
      typeof rawOut === 'string'
        ? rawOut
        : rawOut != null
          ? JSON.stringify(rawOut)
          : failed
            ? 'denied'
            : 'ok';
    this.#emit(
      `[TOOL_RESULT] ${JSON.stringify({
        type: 'tool_result',
        tool_use_id: toolCallId,
        content,
        is_error: failed,
      })}`,
    );
    this.toolCalls.set(toolCallId, {
      ...this.toolCalls.get(toolCallId),
      emittedResult: true,
    });
  }

  /**
   * End-of-turn settlement. Any booked file edit that still lacks tool_use /
   * tool_result is emitted now so frontend useFileChanges sees a complete pair.
   * With assumeSuccess, undecided entries (no terminal status, no explicit
   * allow/deny) are settled as completed — valid at finishSuccess, where the
   * turn ended normally. On the error path (assumeSuccess: false) such entries
   * have no execution evidence, so they are settled as cancelled/failed rather
   * than counted as successful edits that never ran.
   */
  #flushFileEditLedger({ assumeSuccess = true } = {}) {
    for (const [id, tc] of this.toolCalls.entries()) {
      if (!isFileEditTool(tc.name)) continue;
      const input = normalizeEditToolInput(tc.input || {}, []);
      if (!toolPath(input) && !hasUsableEditPayload(input)) continue;

      if (tc.allowed === undefined && !isTerminalToolStatus(tc.status)) {
        if (assumeSuccess) {
          this.toolCalls.set(id, { ...tc, status: 'completed', allowed: true, input });
        } else {
          this.toolCalls.set(id, { ...tc, status: 'cancelled', allowed: false, input });
        }
      } else {
        this.toolCalls.set(id, { ...tc, input });
      }
      this.#emitBookedEdit(id, { forceResult: true });
    }
  }

  #emitToolUse(toolCallId, name, input) {
    this.#emit(
      `[MESSAGE] ${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolCallId,
              name,
              input: input && typeof input === 'object' ? input : {},
            },
          ],
        },
      })}`,
    );
    this.#emit('[BLOCK_RESET]');
  }

  #emitLegacyToolIfNeeded(toolCallId, tc, forceResult) {
    if (!tc.emittedUse) {
      this.#emitToolUse(toolCallId, tc.name || 'tool', tc.input || tc.rawInput || {});
      this.toolCalls.set(toolCallId, { ...this.toolCalls.get(toolCallId), emittedUse: true });
    }
    if (forceResult && !this.toolCalls.get(toolCallId)?.emittedResult) {
      this.#emit(
        `[TOOL_RESULT] ${JSON.stringify({
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: tc.rawOutput != null ? String(typeof tc.rawOutput === 'string' ? tc.rawOutput : JSON.stringify(tc.rawOutput)) : 'ok',
          is_error: tc.status === 'failed',
        })}`,
      );
      this.toolCalls.set(toolCallId, { ...this.toolCalls.get(toolCallId), emittedResult: true });
    }
  }

  #handlePromptResult(result) {
    // session/prompt result: usage is usually under result._meta.usage (Grok CLI 0.2.x),
    // sometimes result.usage, sometimes flat _meta.totalTokens.
    const raw = extractUsageFromAcpEnvelope(result);
    if (raw) {
      this.#emitUsage(raw);
    }
    if (result?.stopReason || result?.stop_reason) {
      // optional
    }
  }

  #buildContentBlocks(text) {
    const blocks = [];
    if (this.thinkingText) {
      blocks.push({ type: 'thinking', thinking: this.thinkingText });
    }
    if (text) {
      blocks.push({ type: 'text', text });
    }
    return blocks.length ? blocks : [{ type: 'text', text: '' }];
  }

  #emitStatus(text) {
    // Not a Claude tag; useful in logs only
    this.error(`[DEBUG] ${text}`);
  }

  #emit(line) {
    this.log(line);
  }

  #emitStreamEndOnce() {
    if (!this.streamStarted || this.streamEnded) return;
    this.streamEnded = true;
    this.#emit('[STREAM_END]');
  }

  #emitMessageEndOnce() {
    if (!this.messageStarted || this.messageEnded) return;
    this.messageEnded = true;
    this.#emit('[MESSAGE_END]');
  }
}

function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractText).join('');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string' || typeof content.content === 'object') {
      return extractText(content.content);
    }
    if (typeof content.delta === 'string') return content.delta;
  }
  return '';
}

const FILE_EDIT_RE = /^(write|write_file|edit|edit_file|replace_string|write_to_file|notebookedit|create_file|multiedit|search_replace|searchreplace|str_replace|strreplace|apply_patch)$/i;

export function isFileEditTool(name) {
  const raw = String(name || '');
  const collapsed = raw.toLowerCase().replace(/[\s-]+/g, '_');
  return FILE_EDIT_RE.test(raw) || FILE_EDIT_RE.test(collapsed);
}

export function isPermissionMethod(method) {
  if (!method) return false;
  const m = String(method);
  // The ACP protocol (and Grok CLI 0.2.x, see grok-acp-client.js) defines
  // exactly one permission request method: session/request_permission. The
  // bare 'request_permission' alias is kept for older Grok builds. Substring
  // matching (m.includes('permission')) was too broad — e.g. a notification
  // like session/permission_update would be misrouted into edit bookkeeping.
  return m === 'session/request_permission' || m === 'request_permission';
}

export function isTerminalToolStatus(status) {
  const s = String(status || '').toLowerCase();
  return (
    s === 'completed' ||
    s === 'complete' ||
    s === 'success' ||
    s === 'succeeded' ||
    s === 'failed' ||
    s === 'error' ||
    s === 'cancelled' ||
    s === 'canceled'
  );
}

export function normalizeEditToolName(rawName, kind = '', title = '') {
  const name = String(rawName || '').trim();
  const lower = name.toLowerCase();
  const k = String(kind || '').toLowerCase();
  const t = String(title || name || '');

  // "Search Replace" / "search-replace" → treat as file edit
  const collapsed = lower.replace(/[\s-]+/g, '_');
  if (FILE_EDIT_RE.test(lower) || FILE_EDIT_RE.test(collapsed)) {
    if (lower === 'write' || lower === 'write_file' || lower === 'create_file' || lower === 'write_to_file') {
      return lower === 'write' ? 'Write' : name;
    }
    if (
      lower === 'edit'
      || lower === 'edit_file'
      || lower === 'replace_string'
      || lower === 'multiedit'
      || collapsed === 'search_replace'
      || collapsed === 'searchreplace'
      || collapsed === 'str_replace'
      || collapsed === 'strreplace'
    ) {
      return lower === 'edit' ? 'Edit' : (collapsed === 'search_replace' || collapsed === 'searchreplace' || /replace/i.test(lower) ? 'Edit' : name);
    }
    return name || 'Edit';
  }

  if (
    k === 'edit'
    || k === 'write'
    || /write|edit|patch|create.?file|overwrite|search\s*replace|str\s*replace/i.test(t)
    || /write|edit|patch|search_?replace|str_?replace/i.test(lower)
    || /write|edit|patch|search_?replace|str_?replace/i.test(collapsed)
  ) {
    if (/write|create|overwrite/i.test(t) || /write|create|overwrite/i.test(lower) || k === 'write') {
      return 'Write';
    }
    return 'Edit';
  }
  return name || 'tool';
}

export function normalizeEditToolInput(rawInput, locations) {
  let input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? { ...rawInput }
      : rawInput != null && rawInput !== ''
        ? { value: rawInput }
        : {};

  // Drop internal acp metadata if present
  if (input._acp) {
    const { _acp, ...rest } = input;
    input = rest;
    if (!locations?.length && Array.isArray(_acp?.locations)) {
      locations = _acp.locations;
    }
  }

  if (!input.path && !input.file_path && !input.filePath) {
    const locPath = firstLocationPath(locations);
    if (locPath) input.path = locPath;
  }

  if (!input.file_path) {
    const p =
      (typeof input.path === 'string' && input.path) ||
      (typeof input.filePath === 'string' && input.filePath) ||
      (typeof input.target_file === 'string' && input.target_file) ||
      (typeof input.targetFile === 'string' && input.targetFile) ||
      '';
    if (p) input.file_path = p;
  }

  if (input.content == null) {
    if (typeof input.contents === 'string') input.content = input.contents;
    else if (typeof input.body === 'string') input.content = input.body;
    else if (
      typeof input.text === 'string' &&
      input.old_string == null &&
      input.oldString == null &&
      input.oldText == null
    ) {
      input.content = input.text;
    }
  }

  if (input.old_string == null) {
    if (typeof input.oldString === 'string') input.old_string = input.oldString;
    else if (typeof input.oldText === 'string') input.old_string = input.oldText;
  }
  if (input.new_string == null) {
    if (typeof input.newString === 'string') input.new_string = input.newString;
    else if (typeof input.newText === 'string') input.new_string = input.newText;
    else if (typeof input.content === 'string' && input.old_string == null) {
      input.new_string = input.content;
    }
  }

  return input;
}

function firstLocationPath(locations) {
  if (!Array.isArray(locations)) return '';
  for (const loc of locations) {
    if (!loc || typeof loc !== 'object') continue;
    if (typeof loc.path === 'string' && loc.path) return loc.path;
    if (typeof loc.file_path === 'string' && loc.file_path) return loc.file_path;
  }
  return '';
}

export function toolPath(input) {
  if (!input || typeof input !== 'object') return '';
  return (
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    (typeof input.filePath === 'string' && input.filePath) ||
    ''
  );
}

export function hasUsableEditPayload(input) {
  if (!toolPath(input)) return false;
  return (
    typeof input?.content === 'string' ||
    typeof input?.contents === 'string' ||
    typeof input?.new_string === 'string' ||
    typeof input?.newString === 'string' ||
    typeof input?.old_string === 'string' ||
    typeof input?.oldString === 'string' ||
    typeof input?.body === 'string' ||
    typeof input?.text === 'string'
  );
}

function richness(input) {
  if (!input || typeof input !== 'object') return 0;
  let s = 0;
  if (toolPath(input)) s += 4;
  if (typeof input.content === 'string' && input.content) s += 3;
  if (typeof input.contents === 'string' && input.contents) s += 3;
  if (typeof input.new_string === 'string' && input.new_string) s += 3;
  if (typeof input.old_string === 'string' && input.old_string) s += 2;
  s += Math.min(Object.keys(input).length, 5);
  return s;
}

export function preferRicher(prev, next) {
  if (!prev || typeof prev !== 'object') return next || {};
  if (!next || typeof next !== 'object') return prev;
  return richness(next) >= richness(prev) ? { ...prev, ...next } : { ...next, ...prev };
}

function canonicalEditName(name, input) {
  if (isFileEditTool(name)) {
    const lower = String(name).toLowerCase();
    if (lower === 'write' || lower === 'write_file' || lower === 'create_file') return 'Write';
    if (lower === 'edit' || lower === 'edit_file') return 'Edit';
    return name;
  }
  // New file with only body → Write
  if (toolPath(input) && (input.content != null || input.new_string != null) && !input.old_string) {
    return 'Write';
  }
  return 'Edit';
}

/**
 * Pull path/content from ACP permission params (same shape as extractPermissionToolInfo).
 * @param {object} params ACP permission request params
 * @param {string} [fallbackId] ledger key to use when the params carry no
 *   toolCallId; callers pass a counter-based id (Date.now() can collide
 *   within the same millisecond). Falls back to a timestamp when omitted.
 */
export function extractPermissionEditInfo(params = {}, fallbackId) {
  const toolCall = params.toolCall || params.tool_call || params.tool || {};
  const rawInput =
    toolCall.rawInput ||
    toolCall.raw_input ||
    toolCall.input ||
    params.input ||
    params.arguments ||
    {};
  const title = toolCall.title || params.title || '';
  const kind = String(toolCall.kind || params.kind || '').toLowerCase();
  const toolCallId =
    toolCall.toolCallId ||
    toolCall.tool_call_id ||
    params.toolCallId ||
    params.tool_call_id ||
    '';
  let toolName =
    toolCall.name || toolCall.toolName || params.toolName || params.name || '';

  const name = normalizeEditToolName(toolName || title, kind, title);
  if (!isFileEditTool(name) && kind !== 'edit' && kind !== 'write') {
    // kind=edit with empty name still counts
    if (!(kind === 'edit' || kind === 'write' || /edit|write|patch/i.test(title))) {
      return null;
    }
  }

  const locations = toolCall.locations || params.locations || [];
  const input = normalizeEditToolInput(
    rawInput && typeof rawInput === 'object' ? rawInput : {},
    locations,
  );
  if (!toolPath(input) && !hasUsableEditPayload(input)) {
    // Still book if path exists alone
    if (!toolPath(input)) return null;
  }

  const id = toolCallId || fallbackId || `perm-edit-${Date.now()}`;
  return {
    toolCallId: String(id),
    name: isFileEditTool(name) ? name : normalizeEditToolName('', kind || 'edit', title || 'Edit'),
    input,
  };
}

export function formatGrokError(error) {
  if (!error) return 'Unknown Grok error';
  const msg = error.message || String(error);
  const stderr = error.stderr || '';
  const combined = `${msg}\n${stderr}`;

  // Already formatted?
  if (msg.startsWith('Grok API denied the request') || msg.startsWith('Grok authentication failed')
      || msg.startsWith('Grok gateway') || msg.startsWith('Grok chat endpoint denied')) {
    return msg;
  }

  // ai-proxy gateway: root POST /v1/chat/completions is locked
  if (/chat\/completions is not routed|billing leak prevention/i.test(combined)
      || (/gateway:/i.test(combined) && /\/v1\/chat\/completions/i.test(combined))) {
    return (
      'Grok gateway rejected the path (403): POST /v1/chat/completions is not routed.\n' +
      'Use a namespaced base URL:\n' +
      '  • API key → …/xai/v1\n' +
      '  • OAuth   → …/grok/v1\n' +
      'Settings → Grok → set API Base URL / OAuth Base URL (not bare …/v1).\n\n' +
      msg
    );
  }

  // ai-proxy gateway: missing x-gateway-token
  if (/unknown or missing x-gateway-token|x-gateway-token/i.test(combined)
      && (/gateway:/i.test(combined) || /401/i.test(combined))) {
    return (
      'Grok gateway auth failed (401): missing or invalid x-gateway-token.\n' +
      'Grok CLI cannot send custom headers. Point base URL at local-agent\n' +
      '(e.g. http://127.0.0.1:18789/xai/v1 or …/grok/v1) which injects the token.\n\n' +
      msg
    );
  }


  // SuperGrok OAuth chat endpoint denial (cli-chat-proxy) — not the same as API-key credits.
  if (/cli-chat-proxy\.grok\.com|Access to the chat endpoint is denied/i.test(combined)) {
    return (
      'Grok chat endpoint denied (403) for this account/session.\n' +
      'OAuth login succeeded, but xAI rejected cli-chat-proxy access.\n' +
      'This is usually an xAI account/subscription entitlement issue (not the JetBrains plugin).\n' +
      'Try:\n' +
      '  1) `grok login --oauth` (or `--device-auth`) again with the SuperGrok account\n' +
      '  2) Confirm SuperGrok/Heavy is active for that account on grok.com / console.x.ai\n' +
      '  3) `grok update` then re-test with: `grok "hi"` in a terminal\n' +
      '  4) If API billing is intended: Settings → Grok → Auth = API key + valid XAI_API_KEY\n\n' +
      msg
    );
  }

  // API-key / team credits denial
  if (/credits|licenses|no credits/i.test(combined) ||
      (/403|permission-denied/i.test(combined) && /console\.x\.ai|XAI_API_KEY|api key/i.test(combined))) {
    const teamUrlMatch = combined.match(/https:\/\/console\.x\.ai\/team\/[a-f0-9-]+/i);
    const teamUrl = teamUrlMatch ? teamUrlMatch[0] : 'https://console.x.ai';
    return (
      `Grok API denied the request (403): no credits/licenses on the team.\n` +
      `Purchase credits: ${teamUrl}\n` +
      `Or switch Settings → Grok → Auth to OAuth if you use SuperGrok.`
    );
  }
  if (/403|permission-denied/i.test(combined)) {
    return (
      'Grok denied the request (403).\n' +
      'If using OAuth/SuperGrok: re-run `grok login` and confirm subscription access to Grok CLI.\n' +
      'If using API key: check credits on console.x.ai and Settings → Grok Auth mode.\n\n' +
      msg
    );
  }
  if (/auth|XAI_API_KEY|authenticate/i.test(combined)) {
    return (
      'Grok authentication failed. Use Settings → Grok Auth (OAuth or API key).\n\n' + msg
    );
  }
  return msg;
}
