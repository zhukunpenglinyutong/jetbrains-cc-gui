/**
 * Live tool projection for Grok CLI.
 *
 * Grok headless stdout has no tool-call events. Tools only appear in
 * ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/chat_history.jsonl as:
 *   - assistant.tool_calls[]  → started
 *   - tool_result             → completed
 *
 * This module tails that file and emits Claude-compatible [MESSAGE] markers.
 */

import { existsSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { StringDecoder } from 'string_decoder';

const MAX_TOOL_RESULT_CHARS = 20000;

/**
 * URL-encode cwd the way Grok CLI names session parent dirs.
 * @param {string} cwd
 */
export function encodeGrokSessionCwd(cwd) {
  const normalized = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  // encodeURIComponent leaves nothing for path separators; Grok uses full encode of the path string.
  return encodeURIComponent(normalized);
}

/**
 * Resolve GROK_HOME / default ~/.grok
 */
export function resolveGrokHome() {
  const env = process.env.GROK_HOME;
  if (env && String(env).trim()) return String(env).trim();
  return join(homedir(), '.grok');
}

/**
 * @param {string} cwd
 * @param {string} sessionId
 */
export function resolveChatHistoryPath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const id = String(sessionId).trim();
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  return join(resolveGrokHome(), 'sessions', encodeGrokSessionCwd(cwd), id, 'chat_history.jsonl');
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: String(raw) };
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw: trimmed };
  }
}

function resolveToolCallName(call) {
  if (!call || typeof call !== 'object') return 'tool';
  if (typeof call.name === 'string' && call.name.trim()) return call.name.trim();
  const fn = call.function;
  if (fn && typeof fn === 'object' && typeof fn.name === 'string' && fn.name.trim()) {
    return fn.name.trim();
  }
  return 'tool';
}

function resolveToolCallArguments(call) {
  if (!call || typeof call !== 'object') return {};
  if (call.arguments != null) return parseArgs(call.arguments);
  const fn = call.function;
  if (fn && typeof fn === 'object' && fn.arguments != null) return parseArgs(fn.arguments);
  return {};
}

function truncateResult(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

function stringifyToolResultContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Emit Claude-compatible tool markers on stdout.
 */
export function emitToolUseMessage(id, name, input) {
  const msg = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: input || {} }],
    },
  };
  console.log(`[MESSAGE] ${JSON.stringify(msg)}`);
}

export function emitToolResultMessage(toolUseId, content, isError = false) {
  const msg = {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: Boolean(isError),
        content: truncateResult(stringifyToolResultContent(content)),
      }],
    },
  };
  console.log(`[MESSAGE] ${JSON.stringify(msg)}`);
}

/**
 * Incremental tail state for one live Grok turn.
 */
export function createToolTailState({ resumeSession = false } = {}) {
  return {
    baselineSet: false,
    skipExistingOnBaseline: Boolean(resumeSession),
    sawMissing: false,
    byteOffset: 0,
    carry: '',
    decoder: new StringDecoder('utf8'),
    seenStarted: new Set(),
    seenCompleted: new Set(),
    syntheticCounter: 0,
  };
}

/**
 * Parse a JSONL chunk for new tool signals (idempotent via seen sets).
 * @returns {{ kind: 'started'|'completed', toolId: string, toolName?: string, input?: object, output?: unknown }[]}
 */
export function drainToolSignalsFromChunk(raw, state) {
  const out = [];
  if (!raw) return out;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const lineType = typeof value?.type === 'string' ? value.type : '';
    if (lineType === 'assistant' && Array.isArray(value.tool_calls)) {
      for (const call of value.tool_calls) {
        const toolName = resolveToolCallName(call);
        let toolId = typeof call?.id === 'string' && call.id.trim() ? call.id.trim() : '';
        if (!toolId) {
          state.syntheticCounter += 1;
          toolId = `grok-tool-${state.syntheticCounter}`;
        }
        if (state.seenStarted.has(toolId)) continue;
        state.seenStarted.add(toolId);
        out.push({
          kind: 'started',
          toolId,
          toolName,
          input: resolveToolCallArguments(call),
        });
      }
    } else if (lineType === 'tool_result') {
      let toolId = typeof value.tool_call_id === 'string' && value.tool_call_id.trim()
        ? value.tool_call_id.trim()
        : '';
      if (!toolId) {
        state.syntheticCounter += 1;
        toolId = `grok-tool-${state.syntheticCounter}`;
      }
      if (state.seenCompleted.has(toolId)) continue;
      state.seenCompleted.add(toolId);
      out.push({
        kind: 'completed',
        toolId,
        output: value.content,
      });
    }
  }
  return out;
}

/**
 * Read new bytes from chat_history.jsonl and return tool signals.
 */
export function pollChatHistoryToolSignals(path, state) {
  if (!path) return [];
  if (!existsSync(path)) {
    state.sawMissing = true;
    return [];
  }

  let fd;
  try {
    fd = openSync(path, 'r');
    const meta = fstatSync(fd);
    const fileLen = meta.size;

    if (!state.baselineSet) {
      state.baselineSet = true;
      // On resume, everything present at FIRST SIGHTING of the file predates
      // this turn — skip it. The file may only appear after the first poll,
      // so baseline must not depend on sawMissing.
      if (state.skipExistingOnBaseline) {
        state.byteOffset = fileLen;
        state.carry = '';
        return [];
      }
      state.byteOffset = 0;
      state.carry = '';
    }

    if (fileLen < state.byteOffset) {
      state.byteOffset = 0;
      state.carry = '';
      state.decoder = new StringDecoder('utf8');
    }

    if (fileLen === state.byteOffset && !state.carry) {
      return [];
    }

    const toRead = fileLen - state.byteOffset;
    const buf = Buffer.alloc(toRead);
    const n = readSync(fd, buf, 0, toRead, state.byteOffset);
    state.byteOffset += n;
    // Decode incrementally so multibyte chars split across reads survive.
    const chunk = state.decoder.write(buf.slice(0, n));
    const combined = state.carry ? state.carry + chunk : chunk;

    // Keep incomplete trailing line
    const lastNl = combined.lastIndexOf('\n');
    let complete;
    if (lastNl === -1) {
      state.carry = combined;
      complete = '';
    } else {
      complete = combined.slice(0, lastNl + 1);
      state.carry = combined.slice(lastNl + 1);
    }

    return drainToolSignalsFromChunk(complete, state);
  } catch (error) {
    // File may appear mid-turn; ignore transient errors.
    return [];
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Emit markers for tool signals.
 */
export function emitToolSignals(signals) {
  for (const signal of signals) {
    if (signal.kind === 'started') {
      emitToolUseMessage(signal.toolId, signal.toolName || 'tool', signal.input || {});
    } else if (signal.kind === 'completed') {
      emitToolResultMessage(signal.toolId, signal.output, false);
    }
  }
}
