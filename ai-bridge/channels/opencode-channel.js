/**
 * OpenCode channel command handler – keeps OpenCode-specific logic separated.
 * Uses local `opencode run --format json` (no host-managed serve in MVP).
 */
import { sendMessage as openCodeSendMessage } from '../services/opencode/message-service.js';
import { listModels as openCodeListModels } from '../services/opencode/models-service.js';

/**
 * Execute an OpenCode command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleOpenCodeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          sessionId,
          cwd,
          model,
          reasoningEffort,
          attachments,
        } = stdinData;
        await openCodeSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || '',
          attachments || []
        );
      } else {
        await openCodeSendMessage(args[0], args[1], args[2], args[3], args[4], []);
      }
      break;
    }

    case 'listModels':
      openCodeListModels();
      break;

    default:
      throw new Error(`Unknown OpenCode command: ${command}`);
  }
}

export function getOpenCodeCommandList() {
  return ['send', 'listModels'];
}
