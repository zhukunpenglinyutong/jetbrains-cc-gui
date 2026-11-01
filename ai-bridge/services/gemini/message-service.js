/**
 * Gemini CLI message service.
 *
 * Spawns local `agy` headless print mode with stream-json event output and maps
 * the NDJSON event stream onto the shared bridge marker protocol (same markers
 * as Grok/Kimi/OpenCode/PI/OMP).
 *
 * CLI:
 *   agy --input-format stream-json --output-format stream-json
 *       --print-timeout 8760h [--conversation <id>] [--model <slug>]
 *       [<posture flags>]
 *   stdin: one NDJSON user message line carrying the prompt
 *   (buildGeminiStdinPayload). The prompt NEVER rides argv — a multi-line
 *   argument value cannot survive the cmd.exe wrapper resolveCliSpawn uses
 *   for `.cmd` shims on Windows (cmd terminates the command at the first
 *   line feed). Requires agy >= 1.1.15 (`--input-format`); the output event
 *   protocol is identical to the `-p` print mode.
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
 * payload status is the source of truth.
 *
 * Thinking summaries are not on the print stream (agy 1.4): `thinking_tokens`
 * is only a count, and a step_update arrives after the narration is already
 * finished. The plugin Thinking flag arrives as stdin `thinking` (missing or
 * null means on, the same default as MarkerCliBridge). When it is on, the
 * conversation DB is polled on a short interval for the whole turn, and again
 * as agent/tool/error steps update, so field 20.3 can reach the Thinking
 * window while the model is still writing it. A summary that grows in place
 * emits only the new suffix. A stream `thinking_delta` is an incremental
 * piece; a stream `thinking` string is a snapshot and only its new suffix is
 * emitted. Field 20.3 is never answer text. agy has no `--thinking` flag, so
 * none is added to argv.
 *
 * Workspace: `cwd` is the workspace the turn runs in — already clamped
 * to the project base by Java's `guardWorkingDirectory`. `requestedCwd` (a
 * sendMessage option, forwarded by MarkerCliBridge in the stdin JSON) is what
 * the user asked for BEFORE that clamp. When the two differ, a visible notice
 * is emitted as the leading content delta — substitution must never be silent.
 * Callers that don't pass `requestedCwd` compare `cwd` directly.
 *
 * Attachments: images are materialized to temp files and referenced as
 * `[Image #N: path]`. Every rejected attachment (explicit non-image, over the
 * shared 2 MB per-image cap, missing/undecodable data) produces a visible
 * `[Notice] Attachment not delivered: "<name>" (<reason>).` leading content
 * delta — one per rejection, never a silent drop. The English reason set is
 * closed and matched verbatim by the webview for localization.
 */

import fs from 'fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { resolveGeminiCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
import { killChildTree, runCliStreaming } from '../../utils/cli-spawn.js';
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
} from '../../utils/marker-protocol.js';
import {
  isBridgeDirectory,
  isTempDirectory,
  normalizePathForComparison,
  selectWorkingDirectory,
} from '../../utils/path-utils.js';
import {
  GROK_MAX_IMAGE_BYTES,
  buildReadPathPromptWithImages,
  cleanupMaterializedImagePaths,
  estimateBase64DecodedBytes,
  materializeImageAttachments,
  parseAttachmentData,
  resolveImageMimeType,
} from '../../utils/cli-image-input.js';
import { reformatFileLineReferences } from '../../utils/file-line-references.js';

const require = createRequire(import.meta.url);

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
 * (no raw English reason interpolated into localized templates). Do not
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

// The shared per-image cap (2 MiB across all providers) announced in
// megabytes — derived from the constant, never a hand-typed figure.
const SIZE_LIMIT_MB = GROK_MAX_IMAGE_BYTES / (1024 * 1024);

/**
 * Closed set of English attachment-rejection reasons, in the exact wording
 * the webview localizes: createLocalizeMessage anchors its regex reason group
 * on exactly these literals, and localizationUtils.test.ts scans this file
 * verbatim for each one. Do not reword or add without updating that regex and
 * all 10 locales.
 *
 * The over-cap reason keeps the canonical "2 MB" spelling as the lockstep
 * anchor for the current GROK_MAX_IMAGE_BYTES; the announced figure itself is
 * derived from the constant at runtime, so the notice always states the
 * active cap.
 */
const ATTACHMENT_NON_IMAGE_REASON = 'only image attachments are supported';
const ATTACHMENT_TOO_LARGE_REASON = 'image exceeds the 2 MB per-image limit'
  .replace('2', String(SIZE_LIMIT_MB));
const ATTACHMENT_INVALID_REASON = 'image data is missing or unreadable';

/**
 * One rejection entry per attachment the shared materializer will skip,
 * classified with the SAME rules and the SAME shared classifiers
 * (resolveImageMimeType / parseAttachmentData / estimateBase64DecodedBytes)
 * the materializer applies — the visible notice layer and the drop layer can
 * never disagree. A path-only attachment (att.path) is delivered as-is by the
 * materializer and is never rejected here. An EMPTY mediaType hint is
 * "assume image" and must never surface as non-image; only an EXPLICIT
 * non-image hint does.
 *
 * "Invalid data" means an unparsable payload or a zero-length decode —
 * Buffer.from(base64, 'base64') never throws, it silently ignores invalid
 * characters, so there is no exception path to report.
 * @param {unknown} attachments
 * @returns {Array<{ name: string, reason: string }>}
 */
function collectAttachmentRejections(attachments) {
  if (!Array.isArray(attachments)) return [];
  const rejections = [];
  for (const att of attachments) {
    if (!att || typeof att !== 'object') {
      rejections.push({ name: 'unnamed', reason: ATTACHMENT_INVALID_REASON });
      continue;
    }
    // Mirror the materializer's path-passthrough BEFORE any data check: a
    // path-bearing attachment is delivered as-is (cli-image-input.js pushes
    // att.path.trim()) and is never rejected here.
    if (typeof att.path === 'string' && att.path.trim()) continue;

    const name = typeof att.fileName === 'string' && att.fileName
      ? att.fileName
      : (typeof att.name === 'string' && att.name ? att.name : 'unnamed');

    // Mirror the materializer's hint resolution EXACTLY: any string mediaType
    // is authoritative — an EMPTY-STRING mediaType means assume-image (through
    // resolveImageMimeType / the parsed data-URL mime) and must not fall
    // through to an explicit mimeType. Only an ABSENT mediaType falls back.
    const hint = typeof att.mediaType === 'string'
      ? att.mediaType
      : (typeof att.mimeType === 'string' ? att.mimeType : '');
    const parsed = parseAttachmentData(att.data);
    const mimeType = resolveImageMimeType(hint, parsed?.mimeType);
    if (!mimeType) {
      rejections.push({ name, reason: ATTACHMENT_NON_IMAGE_REASON });
      continue;
    }
    if (!parsed) {
      rejections.push({ name, reason: ATTACHMENT_INVALID_REASON });
      continue;
    }
    // The helper checks estimated base64 size AND decoded bytes; mirror both
    // checks in the same order.
    if (estimateBase64DecodedBytes(parsed.base64) > GROK_MAX_IMAGE_BYTES) {
      rejections.push({ name, reason: ATTACHMENT_TOO_LARGE_REASON });
      continue;
    }
    const decoded = Buffer.from(parsed.base64, 'base64');
    if (!decoded.length) {
      rejections.push({ name, reason: ATTACHMENT_INVALID_REASON });
      continue;
    }
    if (decoded.length > GROK_MAX_IMAGE_BYTES) {
      rejections.push({ name, reason: ATTACHMENT_TOO_LARGE_REASON });
      continue;
    }
  }
  return rejections;
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

/** Result error agy stamps when print mode stops the conversation stream. */
export const GEMINI_PRINT_MODE_CLOSE_ERROR =
  'The stream was interrupted. Please continue the task you were working on.';

/**
 * Print mode stops the conversation stream after one turn and labels that
 * close with {@link GEMINI_PRINT_MODE_CLOSE_ERROR} even when result.response
 * already holds the answer. The same sentence with an empty response is a
 * real interrupt and must still fail the turn. Divergent streamed text and
 * response text stay a failure too: the close did not confirm the answer.
 * @param {unknown} status Result status string from the CLI.
 * @param {unknown} errorText Result error message from the CLI.
 * @param {unknown} responseText Result response text from the CLI.
 * @param {unknown} streamedText Total agent text streamed across the turn.
 * @param {unknown} [lastStepStreamedText] Agent text streamed in the final step.
 * @returns {boolean} true if the turn delivered a valid response despite the print-mode close error
 */
export function isDeliveredPrintModeClose(status, errorText, responseText, streamedText, lastStepStreamedText) {
  if (status === 'SUCCESS') return false;
  if (String(errorText || '').trim() !== GEMINI_PRINT_MODE_CLOSE_ERROR) return false;
  const response = responseText == null ? '' : String(responseText);
  const streamed = streamedText == null ? '' : String(streamedText);
  if (!response.trim()) return false;
  if (!streamed) return true;
  if (response.startsWith(streamed) || streamed.startsWith(response)) return true;
  if (lastStepStreamedText !== undefined && lastStepStreamedText !== null) {
    const lastStep = String(lastStepStreamedText);
    if (!lastStep) return true;
    return response.startsWith(lastStep) || lastStep.startsWith(response);
  }
  return false;
}

/**
 * Reconciles the final `result.response` text against the text already streamed
 * across the turn and in the final agent step.
 * @param {unknown} responseText Final response text reported in the result event.
 * @param {unknown} totalStreamedText Total agent text streamed across the turn.
 * @param {unknown} [lastStepStreamedText] Agent text streamed in the final (post-tool) step.
 * @returns {{ textToEmit: string, isSuffix: boolean }} reconciliation delta to emit and whether it is a missing suffix
 */
export function reconcileFinalResponseText(responseText, totalStreamedText, lastStepStreamedText) {
  const response = responseText == null ? '' : String(responseText);
  if (!response.trim()) {
    return { textToEmit: '', isSuffix: false };
  }
  const total = totalStreamedText == null ? '' : String(totalStreamedText);
  const hasLastStep = lastStepStreamedText !== undefined && lastStepStreamedText !== null;
  const lastStep = hasLastStep ? String(lastStepStreamedText) : total;

  if (!total) {
    return { textToEmit: response, isSuffix: false };
  }
  if (response.length > total.length && response.startsWith(total)) {
    return { textToEmit: response.slice(total.length), isSuffix: true };
  }
  if (hasLastStep && lastStep && response.length > lastStep.length && response.startsWith(lastStep)) {
    return { textToEmit: response.slice(lastStep.length), isSuffix: true };
  }
  if (hasLastStep && !lastStep && response !== total && !total.endsWith(response)) {
    return { textToEmit: response, isSuffix: false };
  }
  return { textToEmit: '', isSuffix: false };
}

/**
 * agy 1.3.5 print mode soft-denies a tool it cannot prompt for, prints the
 * reason on stderr, and still exits with result.status SUCCESS and an empty
 * response. The notice is one line (optionally prefixed `jetski:`). Unrelated
 * stderr (auth noise, argv echoes) must not become chat text.
 * @param {string} stderrText
 * @returns {string}
 */
export function extractHeadlessDenyNotice(stderrText) {
  const text = String(stderrText || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const kept = lines.filter((line) => (
    /headless mode cannot prompt|auto-denied|user denied permission|no output produced/i.test(line)
  ));
  if (!kept.length) return '';
  const notice = kept.join('\n').replace(/^jetski:\s*/i, '').trim();
  return notice.length > 1500 ? notice.slice(0, 1500) : notice;
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

// Silence-window reap (turn resilience): the ONLY time-based termination in
// the gemini path. It measures stdout SILENCE — every parsed stream line
// resets it — never total elapsed time, so a turn that keeps producing
// output survives indefinitely. The window travels from the Java settings
// via GEMINI_IDLE_REAP_MINUTES on every send; 0 (and, fail-safe, any
// unparseable value) disables the automatic kill entirely.
const DEFAULT_IDLE_REAP_MINUTES = 30;

/**
 * Window in minutes; fractions allowed so the real spawn→timer→tree-kill
 * path can be exercised in seconds (the settings UI only sends integers).
 * Absent/blank → the documented default (30, above the known-legitimate
 * 20-minute silent build tail). `0` → disabled. Unparseable/negative →
 * disabled: an unknown value must never turn into a surprise kill.
 * @param {unknown} raw
 * @returns {number} minutes (0 = disabled)
 */
function parseIdleReapMinutes(raw) {
  if (raw === undefined || raw === null) return DEFAULT_IDLE_REAP_MINUTES;
  const text = String(raw).trim();
  if (!text) return DEFAULT_IDLE_REAP_MINUTES;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Human window for the reap message. Exact 1 renders singular ("1 minute" /
 * "1 second"); everything else uses the plural.
 */
function formatIdleWindow(minutes) {
  if (minutes >= 1) {
    const count = Math.round(minutes * 10) / 10;
    return `${count} ${count === 1 ? 'minute' : 'minutes'}`;
  }
  const seconds = Math.max(1, Math.round(minutes * 60));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/**
 * Actionable reap message: what happened (silence + the bound), the liveness
 * observation (supporting evidence only — never a second kill signal), the
 * likely causes in observed order (stuck interactive prompt — most commonly
 * authentication; backend/network stall) and concrete remedies. Must stay
 * clear of formatGeminiError's auth-classifier phrases (the text is already
 * the final user-facing cause+remedy set) and of the close handler's
 * "ended without a result payload" wording.
 * @param {number} minutes silence window
 * @param {boolean} processAlive
 * @returns {string}
 */
export function buildIdleReapMessage(minutes, processAlive) {
  const observation = processAlive
    ? 'the CLI process was alive but silent — it is likely stuck at an interactive prompt (most commonly authentication) or stalled on the backend/network'
    : 'the CLI process had already exited without delivering a result';
  return [
    `Gemini turn stopped automatically: no output from the Gemini CLI (agy) for ${formatIdleWindow(minutes)}.`,
    `- Likely cause: ${observation}.`,
    "- What to do: run 'agy' in an external terminal to check your login, then cancel and retry; if the turn was legitimately silent (e.g. a long build), raise the window.",
    '- This limit is configurable: set gemini.idleReapMinutes in the Gemini plugin settings (0 disables automatic stopping).',
  ].join('\n');
}

/**
 * manage_subagents reports each child as conversationId plus state.
 * idle means that child has finished and must not keep the parent turn alive.
 * @param {Set<string>} trackedIds
 * @param {string} outputText
 */
export function applyManageSubagentLiveness(trackedIds, outputText) {
  if (!trackedIds || typeof outputText !== 'string' || !outputText) return;
  const objectPattern = /\{[^{}]*"conversationId"\s*:\s*"([0-9a-fA-F-]{36})"[^{}]*\}/g;
  for (const match of outputText.matchAll(objectPattern)) {
    const state = match[0].match(/"state"\s*:\s*"([^"]+)"/);
    if (!state) continue;
    const id = match[1].toLowerCase();
    if (state[1] === 'idle') {
      trackedIds.delete(id);
    } else if (state[1] === 'running') {
      trackedIds.add(id);
    }
  }
}

/**
 * Extracts conversation UUIDs from an invoke_subagent tool result text.
 * Matches conversationId / conversation_id keys only.
 * @param {string} text
 * @returns {string[]} array of lowercase UUID strings
 */
export function extractSubagentConversationIds(text) {
  if (!text || typeof text !== 'string') return [];
  const ids = [];
  const keyRegex = /(?:conversationId|conversation_id)["']?\s*[:=]\s*["']?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/gi;
  for (const m of text.matchAll(keyRegex)) {
    ids.push(m[1].toLowerCase());
  }
  return ids;
}

/**
 * Checks whether a subagent child conversation's database or WAL sidecar was
 * modified within the idle reap window (mtime >= now - idleReapMinutes).
 * @param {string} id child conversation UUID
 * @param {string} cliHome optional home directory override
 * @param {number} idleReapMinutes window in minutes
 * @param {number} [now] current timestamp in ms (defaults to Date.now())
 * @returns {boolean}
 */
export function isSubagentChildLive(id, cliHome, idleReapMinutes, now = Date.now()) {
  if (!id || typeof id !== 'string') return false;
  if (!idleReapMinutes || idleReapMinutes <= 0) return false;
  const cutoff = now - idleReapMinutes * 60 * 1000;
  const baseHome = cliHome || homedir();
  const candidateDirs = [
    join(baseHome, '.gemini', 'antigravity-cli', 'conversations'),
  ];
  for (const dir of candidateDirs) {
    const dbPath = join(dir, `${id}.db`);
    const walPath = join(dir, `${id}.db-wal`);
    try {
      if (fs.existsSync(dbPath)) {
        const stat = fs.statSync(dbPath);
        if (stat.mtimeMs >= cutoff) {
          return true;
        }
      }
    } catch {
      // ignore stat errors
    }
    try {
      if (fs.existsSync(walPath)) {
        const stat = fs.statSync(walPath);
        if (stat.mtimeMs >= cutoff) {
          return true;
        }
      }
    } catch {
      // ignore stat errors
    }
  }
  return false;
}

export function buildGeminiArgs({ sessionId, model, permissionMode = '' }) {
  // NO prompt token ever rides argv: the CLI reads the turn's prompt from
  // stdin as one NDJSON user message (buildGeminiStdinPayload). An argv
  // `-p <prompt>` value cannot carry newlines through the cmd.exe wrapper
  // resolveCliSpawn uses for `.cmd` shims on Windows — cmd terminates the
  // command at the first line feed, truncating every multi-line prompt
  // (pasted code, and every image attachment via the `[Image #N]`
  // injection) to its first line. The JSON-encoded stdin line is
  // newline-safe by construction and drops the argv length cap with it.
  // Requires the `--input-format stream-json` print mode (agy >= 1.1.15,
  // AGY_MIN_VERSION; the output event protocol is unchanged).
  const args = [
    '--input-format',
    'stream-json',
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
 * Encode the turn's prompt as the single stream-json user message the CLI
 * reads from stdin (shape probe-verified against agy 1.1.26:
 * `{"event":"user","message":{"content":[{"type":"text","text":...}]}}`).
 * JSON escaping keeps every newline INSIDE the string literal, so the
 * physical line sent is always single-line — safe through every shell
 * wrapper, including cmd.exe on Windows. The trailing newline closes the
 * message; the CLI runs one turn per line and we send exactly one.
 * @param {string} prompt
 * @returns {string}
 */
export function buildGeminiStdinPayload(prompt) {
  return `${JSON.stringify({
    event: 'user',
    message: { content: [{ type: 'text', text: String(prompt ?? '') }] },
  })}\n`;
}

/**
 * Map an agy usage object onto the canonical `[USAGE]` wire shape — the key
 * names every downstream consumer already reads (util/TokenUsageUtils.java,
 * the webview footer's turnUsage reader, claude's emitUsageTag output):
 * `input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
 * `cache_read_input_tokens`, plus an additive `thinking_tokens`. Present
 * fields map verbatim (a reported 0 stays 0); absent fields stay absent, and
 * `total_tokens` (the CLI's own sum, read by no consumer) is not carried.
 *
 * Returns null when the object carries nothing displayable: absent, empty,
 * all-zero, or thinking-only (a figure must be showable in the per-turn
 * footer to be worth recording; thinking rides along on real turns, but a
 * thinking-only report maps to nothing at all). Emitting a stored zero
 * would read as a genuinely free turn — a lie — so an all-zero report maps
 * to nothing too.
 * @param {unknown} usage raw CLI usage object
 * @returns {Record<string, number>|null} canonical usage or null (nothing to emit)
 */
export function mapGeminiUsageToCanonical(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const mapped = {};
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_tokens);
  const thinking = num(usage.thinking_tokens);
  if (input !== undefined) mapped.input_tokens = input;
  if (output !== undefined) mapped.output_tokens = output;
  // A reported cache-creation figure passes through verbatim instead of
  // being dropped.
  if (cacheCreation !== undefined) mapped.cache_creation_input_tokens = cacheCreation;
  if (cacheRead !== undefined) mapped.cache_read_input_tokens = cacheRead;
  if (thinking !== undefined) mapped.thinking_tokens = thinking;
  // Only a displayable figure (input / output / cache) qualifies; thinking
  // alone never triggers emission (the footer would hide it — nothing would
  // be shown for what was stamped).
  const reported = [input, output, cacheCreation, cacheRead].some((value) => value !== undefined && value > 0);
  return reported ? mapped : null;
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    result += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) {
      return { value: result, end: i };
    }
    shift += 7;
    if (shift > 63) return null;
  }
  return null;
}

function lengthEndsWalk(len, offset, limit) {
  return !Number.isSafeInteger(len) || len < 0 || offset + len > limit;
}

function skipVarint(buf, offset) {
  let i = offset;
  while (i < buf.length && (buf[i] & 0x80) !== 0) {
    i++;
  }
  if (i >= buf.length) return null;
  return i + 1;
}

/**
 * Extract agent display text from step_payload protobuf.
 * Walks the protobuf the way ProtoFields does: field 20 wire 2 contains
 * length-delimited field 1 (assistant prose).
 * Returns the first non-empty valid UTF-8 field 1 text, or null.
 * Ignores field 3 (thinking), field 8 (duplicate), and field 14.
 * @param {Uint8Array|Buffer} payload
 * @returns {string|null}
 */
export function agentDisplayText(payload) {
  if (!payload || !(payload instanceof Uint8Array || Buffer.isBuffer(payload))) {
    return null;
  }
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length === 0) return null;

  const field20Blobs = [];
  let i = 0;
  try {
    while (i < buf.length) {
      const tagRes = readVarint(buf, i);
      if (!tagRes) break;
      i = tagRes.end;
      const tag = tagRes.value;
      const field = Math.floor(tag / 8);
      const wire = tag & 0x7;
      if (field <= 0) break;

      if (wire === 0) {
        const next = skipVarint(buf, i);
        if (next === null) break;
        i = next;
      } else if (wire === 2) {
        const lenRes = readVarint(buf, i);
        if (!lenRes) break;
        i = lenRes.end;
        const len = lenRes.value;
        if (lengthEndsWalk(len, i, buf.length)) break;
        if (field === 20) {
          field20Blobs.push(buf.subarray(i, i + len));
        }
        i += len;
      } else if (wire === 1) {
        if (i + 8 > buf.length) break;
        i += 8;
      } else if (wire === 5) {
        if (i + 4 > buf.length) break;
        i += 4;
      } else {
        break;
      }
    }
  } catch {
    // Truncated or malformed outer payload — keep whatever parsed cleanly.
  }

  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  for (const blob of field20Blobs) {
    let j = 0;
    try {
      while (j < blob.length) {
        const tagRes = readVarint(blob, j);
        if (!tagRes) break;
        j = tagRes.end;
        const tag = tagRes.value;
        const field = Math.floor(tag / 8);
        const wire = tag & 0x7;
        if (field <= 0) break;

        if (wire === 0) {
          const next = skipVarint(blob, j);
          if (next === null) break;
          j = next;
        } else if (wire === 2) {
          const lenRes = readVarint(blob, j);
          if (!lenRes) break;
          j = lenRes.end;
          const len = lenRes.value;
          if (lengthEndsWalk(len, j, blob.length)) break;
          if (field === 1) {
            if (len > 0) {
              try {
                const text = utf8Decoder.decode(blob.subarray(j, j + len));
                if (text.length > 0) {
                  return text;
                }
              } catch {
                // Invalid UTF-8: skip this value and keep scanning the blob.
                j += len;
                continue;
              }
            }
            // Skip empty field 1 blobs and look at the next field-20 blob
            break;
          }
          j += len;
        } else if (wire === 1) {
          if (j + 8 > blob.length) break;
          j += 8;
        } else if (wire === 5) {
          if (j + 4 > blob.length) break;
          j += 4;
        } else {
          break;
        }
      }
    } catch {
      // Truncated inner blob
    }
  }

  return null;
}

function walkLengthDelimited(buf, onField) {
  let i = 0;
  while (i < buf.length) {
    const tagRes = readVarint(buf, i);
    if (!tagRes) return;
    i = tagRes.end;
    const field = Math.floor(tagRes.value / 8);
    const wire = tagRes.value & 0x7;
    if (field <= 0) return;
    if (wire === 0) {
      const next = skipVarint(buf, i);
      if (next === null) return;
      i = next;
    } else if (wire === 2) {
      const lenRes = readVarint(buf, i);
      if (!lenRes) return;
      i = lenRes.end;
      const len = lenRes.value;
      if (lengthEndsWalk(len, i, buf.length)) return;
      if (onField(field, buf.subarray(i, i + len))) return;
      i += len;
    } else if (wire === 1) {
      if (i + 8 > buf.length) return;
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return;
      i += 4;
    } else {
      return;
    }
  }
}

/**
 * Short narrations stored in protobuf field 20.3.
 * agy 1.4.11 keeps these in the conversation DB and does not stream them.
 * Empty and invalid UTF-8 values are skipped. This is not the answer:
 * {@link agentDisplayText} still returns only field 1.
 * @param {Uint8Array|Buffer} payload
 * @returns {string[]}
 */
export function agentThinkingSummaries(payload) {
  if (!payload || !(payload instanceof Uint8Array || Buffer.isBuffer(payload))) {
    return [];
  }
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length === 0) return [];
  const summaries = [];
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    walkLengthDelimited(buf, (field, blob) => {
      if (field !== 20) return false;
      walkLengthDelimited(blob, (innerField, inner) => {
        if (innerField !== 3 || inner.length === 0) return false;
        try {
          const text = utf8Decoder.decode(inner);
          if (text.length > 0) summaries.push(text);
        } catch {
          // Invalid UTF-8: skip this value and keep scanning.
        }
        return false;
      });
      return false;
    });
  } catch {
    // Truncated or malformed payload — keep whatever parsed cleanly.
  }
  return summaries;
}

/**
 * Returns the missing suffix if stored text extends shown text and starts with it.
 * Otherwise returns ''.
 * @param {unknown} shown
 * @param {unknown} stored
 * @returns {string}
 */
export function missingStoredSuffix(shown, stored) {
  if (typeof shown !== 'string' || !shown) return '';
  if (typeof stored !== 'string') return '';
  if (!stored.startsWith(shown)) return '';
  if (stored.length <= shown.length) return '';
  return stored.slice(shown.length);
}

function withConversationSnapshot(convId, cliHome, purpose, read) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    console.error(
      `[gemini] failed to import node:sqlite (${err?.code || err?.name || 'Error'}): ${convId}`
    );
    return null;
  }

  const baseHome = cliHome || homedir();
  const dbPath = join(baseHome, '.gemini', 'antigravity-cli', 'conversations', `${convId}.db`);

  let tempDir = null;
  let db = null;
  try {
    // A read-only open of a live WAL database creates or rewrites -wal/-shm.
    // Copy the trio and open the copy so the conversation files stay untouched.
    const snapshot = copyConversationDbToTemp(dbPath);
    tempDir = snapshot.dir;
    db = new DatabaseSync(snapshot.dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 500;');
    return read(db);
  } catch (err) {
    console.error(
      `[gemini] ${purpose} (${err?.code || err?.name || 'Error'}): ${convId}`
    );
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close error
      }
    }
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }
}

function readLatestStoredAgentReply(convId, cliHome) {
  const row = withConversationSnapshot(convId, cliHome, 'failed to read stored reply', (db) => {
    const userBoundary = db.prepare(
      'SELECT MAX(idx) AS maxUserIdx FROM steps WHERE step_type = 14'
    ).get();
    const minIdx = userBoundary && typeof userBoundary.maxUserIdx === 'number'
      ? userBoundary.maxUserIdx
      : -1;
    const stmt = db.prepare(
      'SELECT step_payload FROM steps WHERE step_type = 15 AND idx > ? ORDER BY idx DESC LIMIT 1'
    );
    return stmt.get(minIdx) || null;
  });
  if (!row || !row.step_payload) return null;
  return agentDisplayText(row.step_payload);
}

/**
 * Extract single-step token usage from a `steps.metadata` protobuf blob.
 * Field 9 (`ModelUsageStats`) holds per-call figures:
 *   field 2: input_tokens (varint)
 *   field 3: output_tokens (varint)
 *   field 4: cache_write_tokens (varint -> cache_creation_input_tokens)
 *   field 5: cache_read_tokens (varint -> cache_read_input_tokens)
 *   field 9: thinking_output_tokens (varint -> thinking_tokens)
 * @param {Uint8Array|Buffer} payload
 * @returns {Record<string, number>|null}
 */
export function agentStepUsage(payload) {
  if (!payload || !(payload instanceof Uint8Array || Buffer.isBuffer(payload))) {
    return null;
  }
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length === 0) return null;
  let usageBlob = null;
  try {
    walkLengthDelimited(buf, (field, blob) => {
      if (field === 9 && blob.length > 0) {
        usageBlob = blob;
        return true;
      }
      return false;
    });
  } catch {
    return null;
  }
  if (!usageBlob) return null;

  const varints = {};
  let i = 0;
  try {
    while (i < usageBlob.length) {
      const tagRes = readVarint(usageBlob, i);
      if (!tagRes) break;
      i = tagRes.end;
      const field = Math.floor(tagRes.value / 8);
      const wire = tagRes.value & 0x7;
      if (field <= 0) break;
      if (wire === 0) {
        const valRes = readVarint(usageBlob, i);
        if (!valRes) break;
        i = valRes.end;
        varints[field] = valRes.value;
      } else if (wire === 2) {
        const lenRes = readVarint(usageBlob, i);
        if (!lenRes) break;
        i = lenRes.end;
        if (lengthEndsWalk(lenRes.value, i, usageBlob.length)) break;
        i += lenRes.value;
      } else if (wire === 1) {
        if (i + 8 > usageBlob.length) break;
        i += 8;
      } else if (wire === 5) {
        if (i + 4 > usageBlob.length) break;
        i += 4;
      } else {
        break;
      }
    }
  } catch {
    // Keep whatever parsed cleanly
  }

  const rawUsage = {
    input_tokens: varints[2] ?? 0,
    output_tokens: varints[3] ?? 0,
    cache_read_tokens: varints[5] ?? 0,
    thinking_tokens: varints[9] ?? 0,
  };
  if (varints[4] !== undefined && varints[4] > 0) {
    rawUsage.cache_creation_input_tokens = varints[4];
  }
  return mapGeminiUsageToCanonical(rawUsage);
}

function readTurnStoredAgentUsages(convId, cliHome) {
  if (!convId) return [];
  const baseHome = cliHome || homedir();
  const dbPath = join(baseHome, '.gemini', 'antigravity-cli', 'conversations', `${convId}.db`);
  if (!fs.existsSync(dbPath)) return [];
  return withConversationSnapshot(convId, cliHome, 'failed to read stored step usage', (db) => {
    try {
      const userBoundary = db.prepare(
        'SELECT MAX(idx) AS maxUserIdx FROM steps WHERE step_type = 14'
      ).get();
      const minIdx = userBoundary && typeof userBoundary.maxUserIdx === 'number'
        ? userBoundary.maxUserIdx
        : -1;
      const rows = db.prepare(
        'SELECT metadata FROM steps WHERE step_type = 15 AND idx > ? AND metadata IS NOT NULL ORDER BY idx'
      ).all(minIdx);
      const usages = [];
      for (const row of rows) {
        if (!row || !row.metadata) continue;
        const mapped = agentStepUsage(row.metadata);
        if (mapped) usages.push(mapped);
      }
      return usages;
    } catch {
      return [];
    }
  }) || [];
}

function readStoredThinkingSteps(convId, cliHome) {
  return withConversationSnapshot(convId, cliHome, 'thinking summaries unavailable', (db) => {
    const userBoundary = db.prepare(
      'SELECT MAX(idx) AS maxUserIdx FROM steps WHERE step_type = 14'
    ).get();
    const minIdx = userBoundary && typeof userBoundary.maxUserIdx === 'number'
      ? userBoundary.maxUserIdx
      : -1;
    const rows = db.prepare(
      'SELECT idx, step_payload FROM steps WHERE step_type = 15 AND idx > ? ORDER BY idx'
    ).all(minIdx);
    const steps = [];
    for (const row of rows) {
      if (!row || row.step_payload == null) continue;
      steps.push({
        idx: row.idx,
        answer: agentDisplayText(row.step_payload),
        summaries: agentThinkingSummaries(row.step_payload),
      });
    }
    return { steps, hasUserSteps: minIdx >= 0 };
  });
}

/**
 * Plugin Thinking flag. Java sends a boolean and treats null as enabled
 * (`thinking == null || thinking` in MarkerCliBridge). Explicit false,
 * "false", 0, and "0" turn summaries off. A missing value stays on.
 * @param {unknown} value
 * @returns {boolean}
 */
export function thinkingEnabled(value) {
  return !(value === false || value === 'false' || value === 0 || value === '0');
}

/**
 * Suffix of a stored thinking summary that was not emitted yet.
 * A longer value that still starts with `previous` is the same paragraph
 * growing in place. Anything else is a replacement and is emitted whole.
 * @param {string} previous
 * @param {string} next
 * @returns {string}
 */
export function thinkingSummaryDelta(previous, next) {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

// A checkpointed SQLite WAL is often larger than the reply we need, and a
// multi-hundred-megabyte synchronous copy would freeze the turn. Anything
// past this is skipped; the streamed text is already on screen.
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

/**
 * Copy src to dest, but stop when a read returns nothing.
 *
 * libuv's fs.copyFileSync (uv__fs_copyfile) records st_size once, then loops
 * on sendfile until that many bytes are copied. sendfile returns 0 once a
 * SQLite checkpoint truncates the WAL, bytes_to_send never reaches 0, and the
 * loop never ends. That call sits on the result path before STREAM_END, so
 * the chat keeps "generating" and the node process burns a core.
 * @param {string} src
 * @param {string} dest
 * @param {number} [maxBytes]
 */
export function copyBoundedFileSync(src, dest, maxBytes = MAX_SNAPSHOT_BYTES) {
  const srcFd = fs.openSync(src, 'r');
  try {
    const st = fs.fstatSync(srcFd);
    if (st.size > maxBytes) {
      const err = new Error('conversation snapshot is too large');
      err.code = 'EFBIG';
      throw err;
    }
    const destFd = fs.openSync(dest, 'w', st.mode);
    try {
      const buf = Buffer.allocUnsafe(SNAPSHOT_CHUNK_BYTES);
      let offset = 0;
      let remaining = st.size;
      while (remaining > 0) {
        const want = remaining < buf.length ? remaining : buf.length;
        const n = fs.readSync(srcFd, buf, 0, want, offset);
        if (n <= 0) break;
        fs.writeSync(destFd, buf, 0, n);
        offset += n;
        remaining -= n;
      }
    } finally {
      fs.closeSync(destFd);
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

function copyConversationDbToTemp(dbPath) {
  if (!fs.existsSync(dbPath)) {
    const err = new Error('conversation database is missing');
    err.code = 'ENOENT';
    throw err;
  }
  const dir = fs.mkdtempSync(join(tmpdir(), 'gemini-reply-'));
  const dest = join(dir, 'conversation.db');
  try {
    copyBoundedFileSync(dbPath, dest);
    for (const suffix of ['-wal', '-shm']) {
      const side = dbPath + suffix;
      if (fs.existsSync(side)) {
        copyBoundedFileSync(side, dest + suffix);
      }
    }
    return { dir, dbPath: dest };
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/**
 * Run one gemini turn. Named options — the eight positional parameters this
 * used to take were one transposition away from silently swapping cwd/model/
 * sessionId in a new caller.
 * @param {object} options
 * @param {string} options.message
 * @param {string} [options.sessionId]
 * @param {string} [options.cwd]
 * @param {string} [options.model] full catalog slug (family+effort is ONE slug)
 * @param {string} [options.reasoningEffort] accepted for caller
 *   compatibility, never forwarded: the effort tier is baked into the full
 *   model slug and some slugs reject a separate --effort flag
 * @param {Array} [options.attachments] image attachments (fileName/mediaType/data)
 * @param {string} [options.requestedCwd] cwd as requested BEFORE Java's clamp (see header)
 * @param {string} [options.permissionMode] unified mode id; mapped onto the CLI
 *   posture flags (--mode plan, --sandbox, ...) for THIS turn
 * @param {string} [options.cliHome] optional home directory override (defaults to os.homedir())
 * @param {unknown} [options.thinking] plugin Thinking flag. false/"false"/0/"0"
 *   suppresses summaries. Omitted or null stays enabled, matching
 *   MarkerCliBridge. Not an agy CLI flag.
 */
export async function sendMessage({
  message,
  sessionId = '',
  cwd = '',
  model = '',
  reasoningEffort = '',
  attachments = [],
  requestedCwd = '',
  permissionMode = '',
  cliHome = '',
  thinking,
} = {}) {
  beginStream();
  const showThinking = thinkingEnabled(thinking);

  let streamEnded = false;
  const emitStreamEndOnce = () => {
    if (streamEnded) return;
    streamEnded = true;
    endStream();
  };

  let hadResult = false;
  let failureEmitted = false;
  let emittedDeltaCount = 0;
  // Concatenation of agent text_delta steps only. Notices emitted before the
  // CLI starts are not part of result.response, so they must not be included
  // when checking whether that response still has an undelivered tail.
  let emittedAgentText = '';
  const emittedTextByStep = new Map();
  let lastAgentStepIndex = null;
  let lastAgentStepText = '';
  // Print mode writes the soft-deny explanation only on stderr, then reports
  // SUCCESS with an empty response. Hold that tail until the result (or the
  // process close, if the notice arrives after the result line).
  let stderrText = '';
  let deniedToolText = '';
  let emptyAnswerPending = false;
  let successReady = false;
  let successFooterEmitted = false;
  let successSessionId = '';
  const emitSuccessFooter = () => {
    if (!successReady || successFooterEmitted) return;
    successFooterEmitted = true;
    console.log(JSON.stringify({ success: true, sessionId: successSessionId }));
  };
  const noteToolDenial = (text, isError) => {
    if (!isError) return;
    const value = String(text || '').trim();
    if (!value) return;
    if (/user denied permission|auto-denied|headless mode cannot prompt|permission check failed/i.test(value)) {
      deniedToolText = value;
    }
  };
  // Collect per-step usage figures for the current turn so CodexMessageHandler's
  // TurnUsageAccumulator can sum all steps into turnUsage while keeping the
  // latest step in message.usage and the context ring.
  const streamStepUsages = new Map();
  let unnamedStreamStepSeq = 0;
  const emitFailure = (errorText, details) => {
    if (failureEmitted || hadResult) return;
    failureEmitted = true;
    const formatted = formatGeminiError(errorText);
    emitSendError(formatted, 'gemini');
    console.log(JSON.stringify({ success: false, error: formatted, details }));
  };

  let promptText = message || '';
  let imagePaths = [];

  // Silence-window reap state. The timer is armed only after a successful
  // spawn (onSpawn), reset by every parsed stdout line, and cleared in the
  // finally below — a reap timer firing on a finished turn is a defect.
  const idleReapMinutes = parseIdleReapMinutes(process.env.GEMINI_IDLE_REAP_MINUTES);
  let reapChild = null;
  let reapTimer = null;
  const clearIdleReapTimer = () => {
    if (reapTimer !== null) {
      clearTimeout(reapTimer);
      reapTimer = null;
    }
  };
  // Declared beside the reap timer so the finally block can stop it. A const
  // inside the try is not visible there, and a leftover interval exits the
  // process with a failure after a successful turn.
  let thinkingPollTimer = null;
  const stopThinkingPoll = () => {
    if (thinkingPollTimer !== null) {
      clearInterval(thinkingPollTimer);
      thinkingPollTimer = null;
    }
  };
  try {
    // EVERYTHING between beginStream() and the spawn stays inside this try:
    // a throw here (CLI resolution, path/attachment work, ...) must still
    // produce a well-formed stream with [SEND_ERROR] + [STREAM_END].
    try {
      // A rejected attachment must never vanish silently: one visible notice
      // per rejection, emitted as the leading content delta before the turn's
      // own answer (same channel as the workspace-substitution notice).
      for (const { name, reason } of collectAttachmentRejections(attachments)) {
        console.error(`[gemini] attachment not delivered: ${name} (${reason})`);
        emitJsonStringMarker(
          '[CONTENT_DELTA]',
          `[Notice] Attachment not delivered: "${name}" (${reason}).\n\n`
        );
      }

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
    const args = buildGeminiArgs({ sessionId, model, permissionMode });

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
    let polledSessionId = currentSessionId;
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
    const activeInvokeSubagentCalls = new Set();
    const trackedSubagentConversationIds = new Set();
    // Per agent-step idx, the summary text already emitted. A later poll of
    // the same row emits only the grown suffix, so a narration can appear
    // while the step is still ACTIVE instead of as one blob at DONE.
    const emittedThinkingByIdx = new Map();
    let emittedThinkingNorm = '';
    let streamThinkingSnapshot = '';
    let lastThinkingPollStamp = '';
    const THINKING_POLL_MS = 200;
    const turnStartMs = Date.now();

    const emitThinking = (text) => {
      if (!text) return;
      emittedThinkingNorm += text;
      emitJsonStringMarker('[THINKING_DELTA]', text);
    };

    // Stream `thinking_delta` is incremental. Stream `thinking` is a snapshot:
    // emit only the suffix that was not already shown.
    const emitStreamThinking = (step) => {
      if (!showThinking || !step || typeof step !== 'object') return;
      if (typeof step.thinking_delta === 'string' && step.thinking_delta) {
        emitThinking(step.thinking_delta);
        streamThinkingSnapshot += step.thinking_delta;
        return;
      }
      if (typeof step.thinking !== 'string' || !step.thinking) return;
      const full = step.thinking;
      const novel = streamThinkingSnapshot && full.startsWith(streamThinkingSnapshot)
        ? full.slice(streamThinkingSnapshot.length)
        : full;
      streamThinkingSnapshot = full;
      if (novel) emitThinking(novel);
    };

    const conversationsDir = () => join(
      cliHome || homedir(),
      '.gemini',
      'antigravity-cli',
      'conversations',
    );

    const conversationDbPath = (convId) => join(
      conversationsDir(),
      `${convId}.db`,
    );

    const discoverTurnConversationId = () => {
      try {
        const dir = conversationsDir();
        const entries = fs.readdirSync(dir);
        let bestId = '';
        let bestMtime = -1;
        for (const name of entries) {
          if (!name.endsWith('.db')) continue;
          const id = normalizeConversationId(name.slice(0, -3));
          if (!id) continue;
          const dbPath = join(dir, name);
          let dbStat;
          try {
            dbStat = fs.statSync(dbPath);
          } catch {
            continue;
          }
          if (!cliHome && dbStat.birthtimeMs < turnStartMs - 50) continue;
          let mtime = dbStat.mtimeMs;
          try {
            const walStat = fs.statSync(`${dbPath}-wal`);
            if (walStat.mtimeMs > mtime) mtime = walStat.mtimeMs;
          } catch {
            // ignore missing -wal sidecar
          }
          const minMtime = cliHome ? turnStartMs - 1000 : turnStartMs - 50;
          if (mtime >= minMtime && mtime > bestMtime) {
            bestMtime = mtime;
            bestId = id;
          }
        }
        return bestId;
      } catch {
        return '';
      }
    };

    const conversationStamp = (dbPath) => {
      const parts = [];
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          const st = fs.statSync(suffix ? `${dbPath}${suffix}` : dbPath);
          parts.push(`${st.mtimeMs}:${st.ctimeMs}:${st.size}`);
        } catch {
          parts.push('-');
        }
      }
      return parts.join('|');
    };

    const summarizeStoredStep = (step, streamed) => {
      const answer = typeof step.answer === 'string' ? step.answer.trim() : '';
      const parts = [];
      for (const summary of step.summaries) {
        const trimmed = typeof summary === 'string' ? summary.trim() : '';
        if (!trimmed) continue;
        if (answer && trimmed === answer) continue;
        if (streamed && trimmed === streamed) continue;
        parts.push(trimmed);
      }
      return parts.join('\n');
    };

    const preseedPriorTurnThinking = (convIdRaw) => {
      if (!showThinking) return;
      const convId = normalizeConversationId(convIdRaw);
      if (!convId) return;
      const rawStamp = conversationStamp(conversationDbPath(convId));
      if (rawStamp.startsWith('-')) return;
      const stored = readStoredThinkingSteps(convId, cliHome);
      if (!stored || !stored.hasUserSteps) return;
      for (const step of stored.steps) {
        emittedThinkingByIdx.set(`${convId}:${step.idx}`, summarizeStoredStep(step, ''));
      }
    };

    // Field 20.3 is the narration. Skip it when it is the answer itself
    // (field 20.1 or the text already streamed). A row whose text grows is
    // emitted again as a suffix. `force` bypasses the unchanged-file skip so
    // a terminal read cannot miss the last write.
    // A missing database is not an error: a new conversation has no file
    // until agy creates it.
    const pollStoredThinking = (convIdRaw, streamedAnswer, force = false) => {
      if (!showThinking) return;
      const convId = normalizeConversationId(convIdRaw);
      if (!convId) return;
      const rawStamp = conversationStamp(conversationDbPath(convId));
      if (rawStamp.startsWith('-')) return;
      const stamp = `${convId}|${rawStamp}`;
      if (!force && stamp === lastThinkingPollStamp) return;
      const stored = readStoredThinkingSteps(convId, cliHome);
      if (!stored) return;
      lastThinkingPollStamp = stamp;
      const streamed = typeof streamedAnswer === 'string' ? streamedAnswer.trim() : '';
      for (const step of stored.steps) {
        const stepKey = `${convId}:${step.idx}`;
        const full = summarizeStoredStep(step, streamed);
        const prev = emittedThinkingByIdx.get(stepKey) || '';
        if (full === prev) continue;
        if (!prev && full && emittedThinkingNorm.includes(full)) {
          emittedThinkingByIdx.set(stepKey, full);
          continue;
        }
        const novel = thinkingSummaryDelta(prev, full);
        emittedThinkingByIdx.set(stepKey, full);
        if (!novel) continue;
        const piece = prev
          ? novel
          : (emittedThinkingNorm && !emittedThinkingNorm.endsWith('\n') && !novel.startsWith('\n')
            ? `\n${novel}`
            : novel);
        emitThinking(piece);
      }
    };

    if (currentSessionId) {
      preseedPriorTurnThinking(currentSessionId);
    }

    // Print mode stays quiet while the model is only thinking, so a poll that
    // waits for the next step_update sees the finished paragraph. The interval
    // reads the same row as it grows and stops at the terminal event.
    const ensureThinkingPoll = () => {
      if (!showThinking) return;
      const tick = () => {
        if (hadResult || failureEmitted) {
          stopThinkingPoll();
          return;
        }
        const targetId = polledSessionId || currentSessionId || discoverTurnConversationId();
        if (targetId) {
          pollStoredThinking(targetId, emittedAgentText, false);
        }
      };
      tick();
      if (thinkingPollTimer === null) {
        thinkingPollTimer = setInterval(tick, THINKING_POLL_MS);
        thinkingPollTimer.unref?.();
      }
    };

    // A tool whose ACTIVE step never gets a terminal state (turn aborted
    // mid-tool, stream closed early) must not leave a dangling tool bubble:
    // close every unresolved tool_use with an error result before the stream
    // ends.
    const flushUnresolvedTools = () => {
      const notice = extractHeadlessDenyNotice(stderrText);
      for (const id of emittedToolUseIds) {
        if (emittedToolResultIds.has(id)) continue;
        emittedToolResultIds.add(id);
        const content = notice || 'interrupted';
        noteToolDenial(content, true);
        emitToolResultMessage({ toolUseId: id, content, isError: true });
      }
      activeInvokeSubagentCalls.clear();
    };

    // Reap decision: no parsed stream line arrived within the window. Kill
    // the detached process group FIRST (the close event that follows lands
    // on an already-failing stream), then exactly one actionable error, then
    // close dangling tool bubbles and end the stream exactly once.
    const reapHungTurn = () => {
      clearIdleReapTimer();
      stopThinkingPoll();
      if (!hadResult && !failureEmitted) {
        let hasLiveChild = activeInvokeSubagentCalls.size > 0;
        if (!hasLiveChild && trackedSubagentConversationIds.size > 0) {
          for (const childId of trackedSubagentConversationIds) {
            if (isSubagentChildLive(childId, cliHome, idleReapMinutes)) {
              hasLiveChild = true;
              break;
            }
          }
        }
        if (hasLiveChild) {
          armIdleReapTimer();
          return;
        }
      }
      const alive = Boolean(reapChild && reapChild.exitCode === null && reapChild.signalCode === null);
      killChildTree(reapChild, 'gemini');
      if (hadResult || failureEmitted) {
        console.error('[gemini] post-result idle reap (process terminated; result already handled)');
        if (!emptyAnswerPending) {
          emitStreamEndOnce();
        }
        return;
      }
      // failureEmitted is set synchronously here, so the close handler that
      // fires a moment later cannot layer the generic NO_RESULT error on top.
      emitFailure(buildIdleReapMessage(idleReapMinutes, alive), { status: 'IDLE_REAP', idleMinutes: idleReapMinutes });
      flushUnresolvedTools();
      emitStreamEndOnce();
    };
    const armIdleReapTimer = () => {
      clearIdleReapTimer();
      if (idleReapMinutes <= 0) return;
      reapTimer = setTimeout(reapHungTurn, idleReapMinutes * 60 * 1000);
      // The child's pipes keep the loop alive while the turn runs; unref only
      // stops an armed timer from delaying a runner that is done otherwise.
      reapTimer.unref?.();
    };
    const resetIdleReapTimer = () => {
      if (reapTimer !== null) {
        armIdleReapTimer();
      }
    };

    await runCliStreaming({
      bin,
      args,
      cwd: workCwd,
      env,
      label: 'gemini',
      // The turn's prompt travels on stdin as one NDJSON user message —
      // see buildGeminiArgs for why it can never ride argv.
      stdinPayload: buildGeminiStdinPayload(promptText),
      emitEndStream: false,
      onSpawn: (child) => {
        reapChild = child;
        armIdleReapTimer();
        ensureThinkingPoll();
      },
      onError: (msg) => {
        // CLI-driven failures (spawn error or nonzero exit, both reported by
        // runCliStreaming through this callback) never override a result
        // already delivered; before a result they are authoritative and must
        // produce the final payload too — a silent dead turn with no JSON
        // footer is worse than a duplicated [SEND_ERROR].
        if (hadResult) {
          console.error('[gemini] post-result CLI error (ignored): ' + msg);
          return;
        }
        emitFailure(msg, { status: 'CLI_ERROR' });
      },
      onStderr: (text) => {
        stderrText = (stderrText + text).slice(-8000);
        if (!emptyAnswerPending) return;
        const notice = extractHeadlessDenyNotice(stderrText);
        if (!notice) return;
        emptyAnswerPending = false;
        emitJsonStringMarker('[CONTENT_DELTA]', notice);
        emitStreamEndOnce();
        emitSuccessFooter();
      },
      onCloseBeforeEnd: () => {
        flushUnresolvedTools();
        // A stream that closes with no result event and no reported error
        // would otherwise be a silent dead turn (exit 0, nothing rendered).
        if (!hadResult && !failureEmitted) {
          emitFailure('Gemini CLI ended without a result payload', { status: 'NO_RESULT' });
        }
        if (emptyAnswerPending) {
          emptyAnswerPending = false;
          const notice = extractHeadlessDenyNotice(stderrText) || deniedToolText;
          if (notice) emitJsonStringMarker('[CONTENT_DELTA]', notice);
          emitStreamEndOnce();
          emitSuccessFooter();
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

        // Evidence of life: EVERY parsed line (known or unknown event) resets
        // the silence window — silence is the only thing the watchdog ever
        // measures, so streaming output keeps a turn alive indefinitely.
        resetIdleReapTimer();

        if (event.event === 'init') {
          // A resumed turn already emitted the id pre-spawn; re-emitting the
          // SAME id would notify the webview twice for one fact. Only a NEW id
          // (CLI-side rotation) is forwarded.
          const initConvId = normalizeConversationId(event.conversation_id);
          if (initConvId) {
            polledSessionId = initConvId;
          }
          if (
            typeof event.conversation_id === 'string'
            && event.conversation_id
            && event.conversation_id !== currentSessionId
          ) {
            currentSessionId = event.conversation_id;
            emitSessionId(event.conversation_id);
          }
          ensureThinkingPoll();
        } else if (event.event === 'step_update') {
          const step = event.step_update;
          if (!step || typeof step !== 'object') return;

          const stepConvId = normalizeConversationId(step.conversation_id);
          if (stepConvId && !polledSessionId) {
            polledSessionId = stepConvId;
          }
          ensureThinkingPoll();

          const watchedStep = step.step_type === 'agent_response'
            || step.step_type === 'tool'
            || step.step_type === 'error_message';
          if (watchedStep) {
            const terminal = step.state === 'DONE' || step.state === 'ERROR';
            pollStoredThinking(
              step.conversation_id || polledSessionId || currentSessionId,
              emittedAgentText,
              terminal,
            );
          }

          if (step.step_type === 'agent_response') {
            const hasStepIndex = step.step_index !== undefined && step.step_index !== null;
            if (hasStepIndex && step.step_index !== lastAgentStepIndex) {
              lastAgentStepIndex = step.step_index;
              lastAgentStepText = emittedTextByStep.get(step.step_index) || '';
            }
            if (typeof step.text_delta === 'string' && step.text_delta) {
              emittedDeltaCount += 1;
              emittedAgentText += step.text_delta;
              lastAgentStepText += step.text_delta;
              if (hasStepIndex) {
                emittedTextByStep.set(step.step_index, lastAgentStepText);
              }
              emitJsonStringMarker('[CONTENT_DELTA]', step.text_delta);
            }
            if (step.usage && typeof step.usage === 'object') {
              const mappedStepUsage = mapGeminiUsageToCanonical(step.usage);
              if (mappedStepUsage) {
                const stepKey = step.step_index !== undefined && step.step_index !== null
                  ? String(step.step_index)
                  : `unnamed-${++unnamedStreamStepSeq}`;
                streamStepUsages.set(stepKey, mappedStepUsage);
              }
            }
          } else if (step.step_type === 'tool') {
            lastAgentStepIndex = null;
            lastAgentStepText = '';
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
            const normalizedToolName = toolName.toLowerCase().trim();
            if ((normalizedToolName === 'manage_subagent' || normalizedToolName === 'manage_subagents')
                && (step.state === 'DONE' || step.state === 'ERROR')) {
              applyManageSubagentLiveness(
                trackedSubagentConversationIds,
                extractToolResultText(step.tool_info?.output),
              );
            }
            if (normalizedToolName === 'invoke_subagent') {
              if (step.state === 'ACTIVE') {
                activeInvokeSubagentCalls.add(toolIndex);
              } else if (step.state === 'DONE') {
                activeInvokeSubagentCalls.delete(toolIndex);
                const outputText = extractToolResultText(step.tool_info?.output);
                for (const cid of extractSubagentConversationIds(outputText)) {
                  trackedSubagentConversationIds.add(cid);
                }
              } else if (step.state === 'ERROR') {
                activeInvokeSubagentCalls.delete(toolIndex);
                const err = step.tool_info?.error;
                const errorText = [
                  extractToolResultText(step.tool_info?.output),
                  typeof err?.message === 'string' ? err.message : '',
                ].filter(Boolean).join('\n');
                for (const cid of extractSubagentConversationIds(errorText)) {
                  trackedSubagentConversationIds.add(cid);
                }
              }
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
              let resultText = err?.message
                ? `${err.type || 'TOOL_ERROR'}: ${err.message}`
                : extractToolResultText(step.tool_info?.output);
              let isError = step.state === 'ERROR' || Boolean(step.tool_info?.isError || step.tool_info?.error);
              // A soft-denied command arrives as DONE with an empty output.
              // The explanation is on stderr; attach it when it is already here.
              if (!String(resultText || '').trim()) {
                const notice = extractHeadlessDenyNotice(stderrText);
                if (notice) {
                  resultText = notice;
                  isError = true;
                }
              }
              noteToolDenial(resultText, isError);
              emitToolResultMessage({
                toolUseId: toolIndex,
                content: resultText,
                isError,
              });
            }
          } else if (step.step_type === 'error_message') {
            // Live captures show these steps carry no renderable content today
            // (no text_delta) — log what IS there instead of passing silently.
            console.error('[gemini] error_message step:', JSON.stringify(step).slice(0, 2000));
          } else if (!KNOWN_STEP_TYPES.has(step.step_type)) {
            console.error(`[gemini] unknown step_update step_type: ${String(step.step_type)}`);
          }
          emitStreamThinking(step);
        } else if (event.event === 'result') {
          // Re-entry guard: exactly one terminal branch per turn.
          if (hadResult) return;
          hadResult = true;
          stopThinkingPoll();
          // Tools still without a terminal state when the result arrives are
          // never getting one — close them before the terminal markers.
          flushUnresolvedTools();
          const res = event.result || {};
          // Emit one [USAGE] per agent step in the current turn before the stream ends.
          // In agy, `result.usage` sums `ModelUsageStats` across every `step_type = 15`
          // row in the ENTIRE conversation database (across all tool calls and all prior
          // turns), which inflates the context ring to tens of millions of tokens on long
          // sessions. Emitting each `step_type = 15` step of the current turn (`idx > maxUserIdx`
          // in `.db`, or `streamStepUsages` from `step_update.usage`) lets Java's
          // TurnUsageAccumulator sum all steps of this turn into `turnUsage` while keeping
          // the latest step in `message.usage` and the context ring.
          const convIdForUsage = normalizeConversationId(
            res.conversation_id || polledSessionId || currentSessionId
          );
          const dbTurnUsages = convIdForUsage ? readTurnStoredAgentUsages(convIdForUsage, cliHome) : [];
          const streamUsages = Array.from(streamStepUsages.values());
          const fallbackResultUsage = mapGeminiUsageToCanonical(res.usage);
          const usagesToEmit = dbTurnUsages.length > 0
            ? dbTurnUsages
            : (streamUsages.length > 0
              ? streamUsages
              : (fallbackResultUsage ? [fallbackResultUsage] : []));
          for (const usageToEmit of usagesToEmit) {
            emitUsage(usageToEmit);
          }
          const finalSessionId = res.conversation_id || currentSessionId || '';
          const responseText = res.response == null ? '' : String(res.response);
          // Print mode's own stream close uses a canned ERROR after the
          // answer is already in result.response. That is not a failed turn.
          const deliveredDespiteClose = isDeliveredPrintModeClose(
            res.status,
            res.error,
            responseText,
            emittedAgentText,
            lastAgentStepText,
          );
          if (res.status === 'SUCCESS' || deliveredDespiteClose) {
            if (deliveredDespiteClose) {
              console.error(
                '[gemini] print mode labeled a delivered answer as an interrupted stream; closing the turn as success'
              );
            }
            // A turn whose text never arrived as text_delta steps must not
            // render empty — fall back to the result's own response text.
            // When deltas did arrive but stop short of result.response (agy
            // closes the turn before the last drip flush reaches stdout), emit
            // only the missing suffix. In multi-step turns, reconcile against
            // both the whole-turn text and the final agent step's text.
            let shown = emittedAgentText;
            let lastStepShown = lastAgentStepText;
            const reconciled = reconcileFinalResponseText(
              responseText,
              emittedAgentText,
              lastAgentStepText,
            );
            if (reconciled.textToEmit) {
              if (reconciled.isSuffix) {
                console.error(
                  `[gemini] result.response extends streamed text by ${reconciled.textToEmit.length} chars; emitting the missing suffix`
                );
              }
              emitJsonStringMarker('[CONTENT_DELTA]', reconciled.textToEmit);
              shown += reconciled.textToEmit;
              lastStepShown += reconciled.textToEmit;
            }

            if (shown) {
              const convId = normalizeConversationId(res.conversation_id || currentSessionId);
              if (convId) {
                const storedText = readLatestStoredAgentReply(convId, cliHome);
                const storedSuffix = missingStoredSuffix(lastStepShown || shown, storedText)
                  || missingStoredSuffix(shown, storedText);
                if (storedSuffix) {
                  console.error(
                    `[gemini] stored reply extends streamed text by ${storedSuffix.length} chars; emitting the missing suffix`
                  );
                  emitJsonStringMarker('[CONTENT_DELTA]', storedSuffix);
                  shown += storedSuffix;
                  lastStepShown += storedSuffix;
                }
              }
            }
            pollStoredThinking(res.conversation_id || currentSessionId, shown, true);

            // agy 1.3.5 closes the turn after a soft-deny: SUCCESS, empty
            // response, no text_delta. The reason is stderr (or the tool
            // error). Wait for process close if the notice has not arrived,
            // so the chat is not a usage footer with no answer.
            successReady = true;
            successSessionId = finalSessionId;
            const denyNotice = extractHeadlessDenyNotice(stderrText);
            if (!shown && denyNotice) {
              emitJsonStringMarker('[CONTENT_DELTA]', denyNotice);
              emitStreamEndOnce();
              emitSuccessFooter();
            } else if (!shown) {
              emptyAnswerPending = true;
            } else {
              emitStreamEndOnce();
              emitSuccessFooter();
            }
          } else {
            pollStoredThinking(res.conversation_id || currentSessionId, emittedAgentText, true);
            // res.response is model prose, never an error cause — log it for
            // diagnosis but keep it out of formatGeminiError / the classifier.
            if (res.response) {
              console.error('[gemini] result.response:', String(res.response).slice(0, 2000));
            }
            failureEmitted = true;
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
    clearIdleReapTimer();
    stopThinkingPoll();
    emitStreamEndOnce();
    await cleanupMaterializedImagePaths(imagePaths);
  }
}
