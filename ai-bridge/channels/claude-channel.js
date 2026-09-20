/**
 * Claude channel command handler – isolates all Claude specific command logic
 * away from the shared channel-manager entry point.
 */
import {
  sendMessage as claudeSendMessage,
  sendMessageWithAttachments as claudeSendMessageWithAttachments,
  rewindFiles as claudeRewindFiles,
  getMcpServerStatus as claudeGetMcpServerStatus,
  getMcpServerTools as claudeGetMcpServerTools
} from '../services/claude/message-service.js';
import {
  resetRuntimePersistent as claudeResetRuntimePersistent
} from '../services/claude/persistent-query-service.js';
import {
  getSessionMessages as claudeGetSessionMessages,
  getSessionMessagesPage as claudeGetSessionMessagesPage,
  getLatestUserMessage as claudeGetLatestUserMessage
} from '../services/claude/session-service.js';

/**
 * Coerce an optional turn cursor supplied through stdin JSON or as a positional
 * CLI argument.
 *
 * Returns null both when the caller supplied no cursor (it then wants the latest
 * page) and when the value is not a usable turn index, so an unusable cursor
 * degrades to the latest page instead of an empty one.
 *
 * Number(null) === 0 and Number('') === 0, so coercing before ruling out
 * "absent" silently turned "no cursor" into "the page before turn 0":
 * buildSessionMessagesPagePayload slices [0, 0) for that cursor and answers with
 * an empty page plus hasMore=false.
 *
 * @param {unknown} raw cursor value from stdin JSON or argv
 * @returns {number|null} non-negative integer turn index, or null when absent/unusable
 */
export function parseOptionalTurnCursor(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Execute a Claude specific command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleClaudeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        // Include streaming and disableThinking when destructuring
        const { message, sessionId, cwd, permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort } = stdinData;
        await claudeSendMessage(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          openedFiles || null,
          agentPrompt || null,
          streaming,  // Pass streaming parameter
          disableThinking || false,  // Pass disableThinking parameter
          reasoningEffort || null  // Pass reasoning effort level
        );
      } else {
        await claudeSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'sendWithAttachments': {
      if (stdinData && stdinData.message !== undefined) {
        // Include streaming when destructuring
        const { message, sessionId, cwd, permissionMode, model, attachments, openedFiles, agentPrompt, streaming, reasoningEffort } = stdinData;
        await claudeSendMessageWithAttachments(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          attachments ? { attachments, openedFiles, agentPrompt, streaming, reasoningEffort } : { openedFiles, agentPrompt, streaming, reasoningEffort }
        );
      } else {
        await claudeSendMessageWithAttachments(args[0], args[1], args[2], args[3], args[4], stdinData);
      }
      break;
    }

    case 'getSession':
      await claudeGetSessionMessages(args[0], args[1]);
      break;

    case 'getSessionPage': {
      // Paginated history load. An absent cursor means "the latest page" and an
      // unusable one degrades to it as well, so a malformed cursor never leaves
      // the user with an empty chat; the Java side additionally falls back to
      // the full-history getSession path when the page request fails.
      const sessionId = stdinData?.sessionId || args[0];
      const cwd = stdinData?.cwd || args[1] || null;
      const beforeTurnRaw = stdinData?.beforeTurn ?? (args[2] !== '' && args[2] !== undefined ? args[2] : null);
      const beforeTurn = parseOptionalTurnCursor(beforeTurnRaw);
      const parsedLimit = Number(stdinData?.limit ?? args[3]);
      const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 30;
      await claudeGetSessionMessagesPage(sessionId, cwd, beforeTurn, limit);
      break;
    }

    case 'getLatestUserMessage':
      await claudeGetLatestUserMessage(args[0], args[1]);
      break;

    case 'rewindFiles': {
      const sessionId = stdinData?.sessionId || args[0];
      const userMessageId = stdinData?.userMessageId || args[1];
      const cwd = stdinData?.cwd || args[2] || null;
      if (!sessionId || !userMessageId) {
        console.log(JSON.stringify({
          success: false,
          error: 'Missing required parameters: sessionId and userMessageId'
        }));
        return;
      }
      await claudeRewindFiles(sessionId, userMessageId, cwd);
      break;
    }

    case 'getMcpServerStatus': {
      const cwd = stdinData?.cwd || args[0] || null;
      await claudeGetMcpServerStatus(cwd);
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      const cwd = stdinData?.cwd || args[1] || null;
      await claudeGetMcpServerTools(serverId, cwd);
      break;
    }

    case 'resetRuntime': {
      await claudeResetRuntimePersistent(stdinData || {});
      break;
    }

    case 'getContextUsage': {
      // getContextUsage requires a persistent runtime (daemon mode).
      // In per-process mode, there is no persistent runtime, so return an error.
      console.log(JSON.stringify({
        success: false,
        error: 'getContextUsage requires daemon mode. No persistent runtime available in per-process mode.'
      }));
      break;
    }

    default:
      throw new Error(`Unknown Claude command: ${command}`);
  }
}

export function getClaudeCommandList() {
  return ['send', 'sendWithAttachments', 'getSession', 'getLatestUserMessage', 'rewindFiles', 'getMcpServerStatus', 'getMcpServerTools', 'resetRuntime', 'getContextUsage'];
}
