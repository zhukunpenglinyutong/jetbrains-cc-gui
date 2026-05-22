/**
 * opencode channel command handler.
 */
import {
  abortSession as openCodeAbortSession,
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
      await openCodeAbortSession(sessionId);
      break;
    }

    default:
      throw new Error(`Unknown opencode command: ${command}`);
  }
}

export function getOpenCodeCommandList() {
  return ['send', 'abort'];
}
