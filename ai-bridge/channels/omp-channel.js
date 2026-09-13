/**
 * OMP channel command handler – keeps OMP-specific logic separated.
 * OMP has no official SDK; this channel shells out to the local CLI.
 */
import { sendMessage as ompSendMessage } from '../services/omp/message-service.js';
import { listModels as ompListModels } from '../services/omp/models-service.js';

/**
 * Execute an OMP command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleOmpCommand(command, args, stdinData) {
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
        await ompSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || '',
          attachments || []
        );
      } else {
        await ompSendMessage(args[0], args[1], args[2], args[3], args[4], []);
      }
      break;
    }

    case 'listModels':
      ompListModels();
      break;

    default:
      throw new Error(`Unknown OMP command: ${command}`);
  }
}

export function getOmpCommandList() {
  return ['send', 'listModels'];
}
