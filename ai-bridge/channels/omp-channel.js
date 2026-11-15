/**
 * OMP channel command handler – keeps OMP-specific logic separated.
 * OMP has no official SDK; this channel drives the local CLI.
 */
import { sendMessage as ompSendMessage } from '../services/omp/message-service.js';
import { listModels as ompListModels } from '../services/omp/models-service.js';
import { listCommands as ompListCommands } from '../services/omp/commands-service.js';
import { getPlanUsage as ompGetPlanUsage } from '../services/omp/plan-usage-service.js';

/**
 * Execute an OMP command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleOmpCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      const input = stdinData && stdinData.message !== undefined
        ? stdinData
        : { message: args[0], sessionId: args[1], cwd: args[2], model: args[3], reasoningEffort: args[4] };
      await ompSendMessage({
        message: input.message,
        sessionId: input.sessionId || '',
        cwd: input.cwd || '',
        model: input.model || '',
        reasoningEffort: input.reasoningEffort || '',
        attachments: input.attachments || [],
        approvalMode: input.approvalMode || '',
      });
      break;
    }

    case 'listModels':
      ompListModels();
      break;

    case 'listCommands':
      await ompListCommands({ cwd: stdinData?.cwd || args[0] || '' });
      break;

    case 'getPlanUsage':
      await ompGetPlanUsage({ model: stdinData?.model || args[0] || '' });
      break;

    default:
      throw new Error(`Unknown OMP command: ${command}`);
  }
}

export function getOmpCommandList() {
  return ['send', 'listModels', 'listCommands', 'getPlanUsage'];
}
