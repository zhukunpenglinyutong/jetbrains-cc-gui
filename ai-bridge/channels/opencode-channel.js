/**
 * opencode channel command handler.
 */
import {
  abortSession as openCodeAbortSession,
  getSessionMessages as openCodeGetSessionMessages,
  listAgents as openCodeListAgents,
  listModels as openCodeListModels,
  sendMessage as openCodeSendMessage
} from '../services/opencode/message-service.js';

/**
 * Execute an opencode command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleOpenCodeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      const {
        message = args[0] || '',
        sessionId = args[1] || '',
        cwd = args[2] || '',
        permissionMode = args[3] || '',
        model = args[4] || '',
        agent = '',
        attachments = []
      } = stdinData || {};

      await openCodeSendMessage(
        message,
        sessionId,
        cwd,
        permissionMode,
        model,
        agent,
        attachments
      );
      break;
    }

    case 'abort': {
      const sessionId = stdinData?.sessionId || args[0] || '';
      const cwd = stdinData?.cwd || args[1] || '';
      await openCodeAbortSession(sessionId, cwd);
      break;
    }

    case 'getSessionMessages': {
      const sessionId = stdinData?.sessionId || args[0] || '';
      const cwd = stdinData?.cwd || args[1] || '';
      await openCodeGetSessionMessages(sessionId, cwd);
      break;
    }

    case 'listModels': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListModels(cwd);
      break;
    }

    case 'listAgents': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListAgents(cwd);
      break;
    }

    default:
      throw new Error(`Unknown opencode command: ${command}`);
  }
}

export function getOpenCodeCommandList() {
  return ['send', 'abort', 'getSessionMessages', 'listModels', 'listAgents'];
}
