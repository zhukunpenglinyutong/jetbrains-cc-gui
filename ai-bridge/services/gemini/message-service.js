/**
 * Gemini CLI message service.
 *
 * Spawns local `agy` headless print mode with stream-json event output and maps
 * the NDJSON event stream onto the shared bridge marker protocol (same markers
 * as Grok/Kimi/OpenCode/PI/OMP).
 *
 * CLI:
 *   agy -p "<text>" --output-format stream-json --print-timeout 8760h
 *       [--conversation <id>] [--model <slug>] [<posture flags>]
 *
 * `--print-timeout` bounds the TOTAL wait for the print-mode response (live
 * probe: `--print-timeout 1s` aborts a turn that would have finished in ~6s
 * with `result.status:"ERROR"`, `error:"timeout waiting for response"`).
 * The CLI default (5m0s) would kill long build turns mid-flight, so we pass
 * an effectively unbounded 8760h and rely on the plugin's own watchdogs.
 *
 * Stream events (NDJSON, live-verified agy 1.1.24 — see fixtures/*.jsonl):
 *   { "event":"init", "conversation_id":"...", "init":{ "cwd", "tools":[], "permission_mode" } }
 *   { "event":"step_update", "step_update":{ "step_type":"user_input"|"agent_response"|"tool"|"error_message", "state":"DONE"|"ACTIVE"|"ERROR", ... } }
 *   { "event":"step_update", "step_update":{ "step_type":"agent_response", "text_delta":"..." } }
 *   { "event":"step_update", "step_update":{ "step_type":"tool", "state":"ACTIVE", "tool_name":"...", "tool_info":{ "name", "parameters":{} } } }
 *   { "event":"step_update", "step_update":{ "step_type":"tool", "state":"DONE", "tool_name":"...", "tool_info":{ "name", "parameters":{}, "output":"..." } } }
 *   { "event":"step_update", "step_update":{ "step_type":"tool", "state":"ERROR", "tool_name":"...", "tool_info":{ "name", "parameters":{}, "error":{ "type":"TOOL_ERROR", "message":"..." } } } }
 *   { "event":"result", "result":{ "status":"SUCCESS"|"ERROR", "conversation_id", "response", "error", "duration_seconds", "num_turns", "usage":{} } }
 *
 * Exit code is NOT authoritative: live captures produced 0 (success), 1
 * (timeout / quota ERROR) and 2 (print-mode slash command). The `result`
 * payload status is the source of truth (AC3).
 *
 * Workspace (AC5): `cwd` is the workspace the turn runs in — already clamped
 * to the project base by Java's `guardWorkingDirectory`. `requestedCwd` (7th
 * arg, forwarded by MarkerCliBridge in the stdin JSON) is what the user asked
 * for BEFORE that clamp. When the two differ, a visible notice is emitted as
 * the leading content delta — substitution must never be silent. Callers that
 * don't pass `requestedCwd` keep the previous behaviour (compare `cwd`).
 */

import fs from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { resolveGeminiCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
import { runCliStreaming } from '../../utils/cli-spawn.js';
import { PermissionMapperFactory } from '../../utils/permission-mapper.js';
import {
  beginStream,
  emitJsonStringMarker,
  emitSendError,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  emitUsage,
  endStream,
  isNonEmptySessionId,
  safePromptArg,
} from '../../utils/marker-protocol.js';
import {
  isBridgeDirectory,
  isTempDirectory,
  normalizePathForComparison,
  selectWorkingDirectory,
} from '../../utils/path-utils.js';
import {
  buildReadPathPromptWithImages,
  cleanupMaterializedImagePaths,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';
import { reformatFileLineReferences } from '../../utils/file-line-references.js';

function logDebug(...args) {
  console.error('[DEBUG][Gemini]', ...args);
}

// step_update.step_type vocabulary recorded from the live CLI (agy 1.1.24,
// see fixtures/*.jsonl). Unknown values are logged and skipped.
const KNOWN_STEP_TYPES = new Set(['user_input', 'agent_response', 'tool', 'error_message']);

/**
 * Conversation id usable for `--conversation`: non-empty, not one of the
 * "undefined"/"null" string sentinels the UI may pass for "no session", and
 * not dash-led (a dash-led token would parse as a CLI flag).
 * @param {unknown} value
 * @returns {string} trimmed id or ''
 */
export function normalizeConversationId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return '';
  if (trimmed.startsWith('-')) return '';
  return isNonEmptySessionId(trimmed) ? trimmed : '';
}

/**
 * User-facing working directory with sentinel/blank/non-string values
 * collapsed to '' ("nothing usable requested"). Mirrors the sentinels the
 * webview/Java sides use for "no cwd".
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSentinelPath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return '';
  return trimmed;
}

/**
 * Why a requested workspace was rejected — a closed set whose English strings
 * are matched verbatim by the webview (createLocalizeMessage anchors its regex
 * reason group on exactly these literals) and localized in all 10 locales
 * (NFR8: no raw English reason interpolated into localized templates). Do not
 * reword or add strings without updating that regex and every locale.
 *
 * The bridge-directory check comes first: an existing-but-forbidden directory
 * is a policy rejection, not a filesystem problem. statSync failures other
 * than ENOENT (EACCES/EPERM/ELOOP) mean the path exists but cannot be
 * inspected — that is "unsafe", not "missing". An existing directory that is
 * an OS temp dir is rejected on its own terms: the agent must never run there.
 * @param {string} requested
 * @returns {string}
 */
export function classifyWorkspaceSubstitutionReason(requested) {
  if (isBridgeDirectory(requested)) return 'plugin-internal directory';
  let stats;
  try {
    stats = fs.statSync(requested);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'directory does not exist';
    return 'unsafe working directory';
  }
  if (!stats.isDirectory()) return 'not a directory';
  if (isTempDirectory(requested)) return 'temporary directory';
  return 'unsafe working directory';
}

export function isGeminiAuthError(text) {
  if (!text) return false;
  const str = String(text);
  // Phrase-level signals only: bare "401"/"unauthorized"/"sign in" also occur
  // in ordinary tool output (git push, HTTP APIs) and must not flip a build
  // failure into a credential-remedy message.
  return /not logged in|not authenticated|unauthenticated|authentication (?:failed|required)|login required|credentials (?:not found|expired|invalid)|no active credentials|please sign in/i.test(str);
}

export function formatGeminiError(errorText) {
  if (!errorText) return 'Unknown Gemini error';
  const text = String(errorText).trim();
  if (isGeminiAuthError(text)) {
    return [
      'Gemini CLI authentication required:',
      '- Cause: The Gemini CLI (agy) is not logged in or credentials have expired.',
      "- Resolution: Run 'agy' in an external terminal and complete the interactive Google Sign-In flow.",
      '- Note: This plugin does not manage Google credentials or perform Google login in-plugin.',
      '',
      `- Error details: ${text}`,
    ].join('\n');
  }
  return text;
}

export function extractToolResultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Model ids that mean "no explicit model": the UI sentinel `auto` (omit
 * `--model`, let the CLI pick its own default), the generic sentinels Java's
 * normalizeCliModelForProvider also collapses, and dash-led tokens (they
 * would parse as CLI flags). Real slugs — including the agy catalog's
 * cross-vendor `claude-*` / `gpt-*` entries — pass through untouched.
 * @param {unknown} value
 * @returns {string} the slug to send, or '' for "no --model flag"
 */
export function normalizeGeminiModelId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-')) return '';
  const sentinel = new Set(['auto', 'default', '__config_default__', '(default)', 'undefined', 'null']);
  if (sentinel.has(trimmed.toLowerCase())) return '';
  return trimmed;
}

export function buildGeminiArgs({ message, sessionId, model, permissionMode = '' }) {
  const args = [
    '-p',
    safePromptArg(message),
    '--output-format',
    'stream-json',
    '--print-timeout',
    '8760h',
  ];
  const conversationId = normalizeConversationId(sessionId);
  if (conversationId) {
    args.push('--conversation', conversationId);
  }
  const modelId = normalizeGeminiModelId(model);
  if (modelId) {
    args.push('--model', modelId);
  }
  // The unified permission mode becomes the CLI posture flags (--mode plan,
  // --dangerously-skip-permissions, ...). Unknown/blank modes map to no flags
  // — deny-by-default is what the CLI does outside a posture anyway.
  args.push(...PermissionMapperFactory.toProvider('gemini', permissionMode).args);
  return args;
}

/**
 * @param {string} message
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} model full catalog slug (family+effort is ONE slug)
 * @param {string} [reasoningEffort] accepted for positional compatibility,
 *   never forwarded: the effort tier is baked into the full model slug and
 *   some slugs reject a separate --effort flag
 * @param {Array} [attachments] image attachments (fileName/mediaType/data)
 * @param {string} [requestedCwd] cwd as requested BEFORE Java's clamp (see header)
 * @param {string} [permissionMode] unified mode id; mapped onto the CLI
 *   posture flags (--mode plan, --sandbox, ...) for THIS turn
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  reasoningEffort = '',
  attachments = [],
  requestedCwd = '',
  permissionMode = ''
) {
  beginStream();

  let streamEnded = false;
  const emitStreamEndOnce = () => {
    if (streamEnded) return;
    streamEnded = true;
    endStream();
  };

  let hadResult = false;
  let failureEmitted = false;
  let emittedDeltaCount = 0;
  const emitFailure = (errorText, details) => {
    if (failureEmitted) return;
    failureEmitted = true;
    const formatted = formatGeminiError(errorText);
    emitSendError(formatted, 'gemini');
    console.log(JSON.stringify({ success: false, error: formatted, details }));
  };

  let promptText = message || '';
  let imagePaths = [];
  try {
    // Non-image attachments are silently dropped by the image materializer;
    // say so on stderr instead of vanishing them without a trace.
    const nonImages = (Array.isArray(attachments) ? attachments : []).filter((att) => {
      // Malformed entries (strings, numbers, null) cannot be images — count them.
      if (!att || typeof att !== 'object') return true;
      // Mirror the materializer's hint resolution (mediaType || mimeType); an
      // empty hint is undecided — the materializer treats it as image data, so
      // it must not be pre-announced as ignored here.
      const hint = typeof att.mediaType === 'string' && att.mediaType
        ? att.mediaType
        : (typeof att.mimeType === 'string' ? att.mimeType : '');
      if (!hint.trim()) return false;
      return !hint.trim().toLowerCase().startsWith('image/');
    });
    if (nonImages.length > 0) {
      console.error(`[gemini] ignoring ${nonImages.length} non-image attachment(s): `
        + nonImages
          .map((att) => `${att.mediaType || att.mimeType || 'unknown'}:${att.fileName || att.name || 'unnamed'}`)
          .join(', '));
    }

    // EVERYTHING between beginStream() and the spawn stays inside this try:
    // a throw here (CLI resolution, path/attachment work, ...) must still
    // produce a well-formed stream with [SEND_ERROR] + [STREAM_END].
    try {
      imagePaths = await materializeImageAttachments(attachments);
      if (imagePaths.length > 0) {
        promptText = buildReadPathPromptWithImages(promptText, imagePaths);
        logDebug('image attachments', imagePaths.length, imagePaths);
      }
    } catch (err) {
      // Images never block the turn: continue without them.
      console.error('[Gemini] failed to materialize image attachments:', err?.message || err);
    }
    promptText = reformatFileLineReferences(promptText);

    const bin = resolveGeminiCliPath();
    const args = buildGeminiArgs({ message: promptText, sessionId, model, permissionMode });

    const env = { ...process.env };
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    enrichPathWithBinDirs(env, commonCliBinDirs(home));

    const workCwd = selectWorkingDirectory(cwd);
    const requestedRaw = normalizeSentinelPath(requestedCwd || cwd);
    // A relative requestedCwd means "relative to the workspace the turn runs
    // in", and ANY request needs normalizing before comparing: resolve()
    // handles both relative and absolute forms, stripping trailing separators
    // and collapsing . / .. — so "/proj/sub/" compares equal to the resolve()d
    // workCwd "/proj/sub" instead of reading as a substitution.
    const requested = requestedRaw ? resolve(workCwd, requestedRaw) : '';

    if (requested && normalizePathForComparison(workCwd) !== normalizePathForComparison(requested)) {
      const reason = classifyWorkspaceSubstitutionReason(requested);
      const notice = `[Notice] Working directory substituted: requested "${requested}", using "${workCwd}" (${reason}).\n\n`;
      emitJsonStringMarker('[CONTENT_DELTA]', notice);
    }

    let currentSessionId = normalizeConversationId(sessionId);
    if (currentSessionId) {
      emitSessionId(currentSessionId);
    }

    logDebug('spawn', bin, args.slice(0, 2).join(' '), `promptLen=${String(promptText || '').length}`, `cwd=${workCwd}`);

    // step_index values whose tool_use marker was already emitted — tool steps
    // report ACTIVE then DONE/ERROR for the same index.
    const emittedToolUseIds = new Set();
    const emittedToolResultIds = new Set();
    // FIFO of tool_use ids minted without a step_index whose terminal state
    // has not arrived yet. Interleaved unnamed tools (ACTIVE A, ACTIVE B,
    // DONE A, ERROR B) pair in start order, not "most recent wins".
    const pendingUnnamedToolIds = [];

    // A tool whose ACTIVE step never gets a terminal state (turn aborted
    // mid-tool, stream closed early) must not leave a dangling tool bubble:
    // close every unresolved tool_use with an error result before the stream
    // ends.
    const flushUnresolvedTools = () => {
      for (const id of emittedToolUseIds) {
        if (emittedToolResultIds.has(id)) continue;
        emittedToolResultIds.add(id);
        emitToolResultMessage({ toolUseId: id, content: 'interrupted', isError: true });
      }
    };

    await runCliStreaming({
      bin,
      args,
      cwd: workCwd,
      env,
      label: 'gemini',
      emitEndStream: false,
      onError: (msg) => {
        // CLI-driven failures (spawn error or nonzero exit, both reported by
        // runCliStreaming through this callback) never override a result
        // already delivered; before a result they are authoritative and must
        // produce the final payload too (R-6) — a silent dead turn with no
        // JSON footer is worse than a duplicated [SEND_ERROR].
        if (hadResult) {
          console.error('[gemini] post-result CLI error (ignored): ' + msg);
          return;
        }
        emitFailure(msg, { status: 'CLI_ERROR' });
      },
      onCloseBeforeEnd: () => {
        flushUnresolvedTools();
        // A stream that closes with no result event and no reported error
        // would otherwise be a silent dead turn (exit 0, nothing rendered).
        if (!hadResult && !failureEmitted) {
          emitFailure('Gemini CLI ended without a result payload', { status: 'NO_RESULT' });
        }
        emitStreamEndOnce();
      },
      onLine: (line) => {
        if (!line || !line.trim()) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          console.error('[gemini] unparseable stream line:', String(line).slice(0, 500));
          return;
        }
        if (!event || typeof event !== 'object') return;

        if (event.event === 'init') {
          // A resumed turn already emitted the id pre-spawn; re-emitting the
          // SAME id would notify the webview twice for one fact. Only a NEW id
          // (CLI-side rotation) is forwarded.
          if (
            typeof event.conversation_id === 'string'
            && event.conversation_id
            && event.conversation_id !== currentSessionId
          ) {
            currentSessionId = event.conversation_id;
            emitSessionId(event.conversation_id);
          }
        } else if (event.event === 'step_update') {
          const step = event.step_update;
          if (!step || typeof step !== 'object') return;

          if (step.step_type === 'agent_response') {
            if (typeof step.text_delta === 'string' && step.text_delta) {
              emittedDeltaCount += 1;
              emitJsonStringMarker('[CONTENT_DELTA]', step.text_delta);
            }
            if (step.usage && typeof step.usage === 'object') {
              emitUsage(step.usage);
            }
          } else if (step.step_type === 'tool') {
            // Live-verified shapes (agy 1.1.24, fixtures/):
            //   ACTIVE: { step_index, state:"ACTIVE", step_type:"tool", tool_name, tool_info:{ name, parameters } }
            //   DONE:   ... tool_info:{ name, parameters, output: "<string>" }
            //   ERROR:  ... tool_info:{ name, parameters, error:{ type:"TOOL_ERROR", message } }
            const hasIndex = step.step_index !== undefined && step.step_index !== null;
            let toolIndex;
            if (hasIndex) {
              toolIndex = String(step.step_index);
            } else if (step.state === 'DONE' || step.state === 'ERROR') {
              // Terminal state of an unnamed tool: pair with the oldest
              // still-pending tool_use; mint a fresh unique id only when no
              // ACTIVE step announced one.
              if (!pendingUnnamedToolIds.length) {
                pendingUnnamedToolIds.push(`tool-${emittedToolUseIds.size + 1}`);
              }
              toolIndex = pendingUnnamedToolIds.shift();
            } else {
              toolIndex = `tool-${emittedToolUseIds.size + 1}`;
              pendingUnnamedToolIds.push(toolIndex);
            }
            const toolName = step.tool_name || step.tool_info?.name || 'tool';
            const toolParams = step.tool_info?.parameters && typeof step.tool_info.parameters === 'object'
              ? step.tool_info.parameters
              : {};

            const isKnownState = step.state === 'ACTIVE' || step.state === 'DONE' || step.state === 'ERROR';
            if (!isKnownState) {
              console.error(`[gemini] unknown tool step state: ${String(step.state)}`);
            }
            // Every known state introduces the tool exactly once — a DONE or
            // ERROR may arrive without a preceding ACTIVE step, and the webview
            // must never see a dangling tool_result.
            if (isKnownState && !emittedToolUseIds.has(toolIndex)) {
              emittedToolUseIds.add(toolIndex);
              emitToolUseMessage({ id: toolIndex, name: toolName, input: toolParams });
            }
            if ((step.state === 'DONE' || step.state === 'ERROR') && !emittedToolResultIds.has(toolIndex)) {
              emittedToolResultIds.add(toolIndex);
              const err = step.tool_info?.error;
              const resultText = err?.message
                ? `${err.type || 'TOOL_ERROR'}: ${err.message}`
                : extractToolResultText(step.tool_info?.output);
              emitToolResultMessage({
                toolUseId: toolIndex,
                content: resultText,
                isError: step.state === 'ERROR' || Boolean(step.tool_info?.isError || step.tool_info?.error),
              });
            }
          } else if (step.step_type === 'error_message') {
            // Live captures show these steps carry no renderable content today
            // (no text_delta) — log what IS there instead of passing silently.
            console.error('[gemini] error_message step:', JSON.stringify(step).slice(0, 2000));
          } else if (!KNOWN_STEP_TYPES.has(step.step_type)) {
            console.error(`[gemini] unknown step_update step_type: ${String(step.step_type)}`);
          }
        } else if (event.event === 'result') {
          // Re-entry guard: exactly one terminal branch per turn.
          if (hadResult) return;
          hadResult = true;
          // Tools still without a terminal state when the result arrives are
          // never getting one — close them before the terminal markers.
          flushUnresolvedTools();
          const res = event.result || {};
          if (res.usage && typeof res.usage === 'object') {
            emitUsage(res.usage);
          }
          const finalSessionId = res.conversation_id || currentSessionId || '';
          if (res.status === 'SUCCESS') {
            // A turn whose text never arrived as text_delta steps must not
            // render empty — fall back to the result's own response text.
            const responseText = res.response == null ? '' : String(res.response);
            if (emittedDeltaCount === 0 && responseText.trim()) {
              emitJsonStringMarker('[CONTENT_DELTA]', responseText);
            }
            emitStreamEndOnce();
            console.log(JSON.stringify({ success: true, sessionId: finalSessionId }));
          } else {
            // res.response is model prose, never an error cause — log it for
            // diagnosis but keep it out of formatGeminiError / the classifier.
            if (res.response) {
              console.error('[gemini] result.response:', String(res.response).slice(0, 2000));
            }
            const rawError = res.error || `Turn failed with status: ${res.status}`;
            const formatted = formatGeminiError(rawError);
            emitSendError(formatted, 'gemini');
            emitStreamEndOnce();
            console.log(JSON.stringify({
              success: false,
              error: formatted,
              details: { status: res.status, rawError },
            }));
          }
        } else {
          console.error(`[gemini] unknown event: ${String(event.event)}`);
        }
      },
    });
  } catch (err) {
    // A throw after a result (or after a failure) is late — the terminal
    // branch already went out on the wire and must not be overridden.
    if (hadResult || failureEmitted) {
      console.error('[gemini] late failure after terminal event (ignored):', err?.message || err);
    } else {
      emitFailure(err?.message || String(err), { status: 'PRE_SPAWN_ERROR' });
    }
  } finally {
    emitStreamEndOnce();
    await cleanupMaterializedImagePaths(imagePaths);
  }
}
