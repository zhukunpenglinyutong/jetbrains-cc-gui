/**
 * Kimi channel command handler – keeps Kimi-specific logic separated.
 * Kimi has no official SDK; this channel shells out to the local CLI.
 */
import { sendMessage as kimiSendMessage } from '../services/kimi/message-service.js';
import { listModels as kimiListModels } from '../services/kimi/models-service.js';

/**
 * Execute a Kimi command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleKimiCommand(command, args, stdinData) {
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
        await kimiSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || '',
          attachments || []
        );
      } else {
        await kimiSendMessage(args[0], args[1], args[2], args[3], args[4], []);
      }
      break;
    }

    case 'listModels':
      kimiListModels();
      break;

    default:
      throw new Error(`Unknown Kimi command: ${command}`);
  }
}

export function getKimiCommandList() {
  return ['send', 'listModels'];
}
