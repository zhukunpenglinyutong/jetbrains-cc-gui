/**
 * Gemini channel command handler – keeps Gemini-specific logic separated.
 * Gemini has no official SDK in this mode; this channel shells out to the local CLI.
 */
import {
  beginStream,
  emitSendError,
  endStream,
} from '../utils/marker-protocol.js';
import { sendMessage as geminiSendMessage } from '../services/gemini/message-service.js';
import { listModels as geminiListModels } from '../services/gemini/models-service.js';

/**
 * Reject a blank send without spawning `agy -p ""` (which the CLI answers with
 * an interactive-usage error). Fail through the standard marker protocol so
 * Java's BaseSDKBridge records the failure and the webview shows it.
 */
function rejectEmptyMessage() {
  const text = 'Gemini send failed: the message is empty. Type a message and try again.';
  beginStream();
  emitSendError(text, 'gemini');
  endStream();
  // `details.status` lets tests and future consumers tell this rejection apart
  // from a CLI-driven send failure with the same marker shape.
  console.log(JSON.stringify({ success: false, error: text, details: { status: 'EMPTY_MESSAGE' } }));
}

/**
 * Anything that is not a non-blank string counts as empty (missing stdin key,
 * null, numbers from malformed JSON) — none of it may reach `agy -p ""`.
 * @param {unknown} message
 * @returns {boolean}
 */
function isBlankMessage(message) {
  return typeof message !== 'string' || !message.trim();
}

/**
 * Execute a Gemini command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleGeminiCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          sessionId,
          cwd,
          model,
          attachments,
          // cwd as requested BEFORE Java's clamp — enables the visible
          // substitution notice (AC5). `cwd` stays the guarded workspace.
          requestedCwd,
          permissionMode,
          // `reasoningEffort` rides along in the Java stdin payload
          // (MarkerCliBridge is provider-neutral) but is deliberately ignored:
          // the effort tier is baked into the full model slug and some slugs
          // reject a separate --effort flag, so none is ever sent.
          reasoningEffort: _ignoredReasoningEffort,
          // `preset` rides along in the Java stdin payload (MarkerCliBridge is
          // provider-neutral) but is deliberately ignored: gemini has no
          // per-turn preset concept.
          preset: _ignoredPreset,
        } = stdinData;
        if (isBlankMessage(message)) {
          rejectEmptyMessage();
          break;
        }
        await geminiSendMessage({
          message,
          sessionId: sessionId || '',
          cwd: cwd || '',
          model: model || '',
          // `reasoningEffort` rides along in the stdin payload but is
          // deliberately never forwarded (see the destructuring above).
          attachments: attachments || [],
          requestedCwd: requestedCwd || '',
          // Applied per turn: the unified mode becomes the CLI posture flags
          // inside the service (headless print mode has no mid-turn switch).
          permissionMode: typeof permissionMode === 'string' ? permissionMode : '',
        });
      } else {
        const message = args[0];
        if (isBlankMessage(message)) {
          rejectEmptyMessage();
          break;
        }
        await geminiSendMessage({
          message,
          sessionId: args[1],
          cwd: args[2],
          model: args[3],
          reasoningEffort: args[4],
        });
      }
      break;
    }

    case 'listModels':
      geminiListModels();
      break;

    default:
      throw new Error(`Unknown Gemini command: ${command}`);
  }
}

export function getGeminiCommandList() {
  return ['send', 'listModels'];
}
