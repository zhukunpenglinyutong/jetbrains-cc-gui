/**
 * Codex channel command handler – keeps Codex specific logic separated.
 */
import { getMcpServerTools as codexGetMcpServerTools } from '../services/codex/message-service.js';
import { listModels as codexListModels } from '../services/codex/models-service.js';
import { codexSendPersistent, codexShutdownPersistentRuntimes } from '../services/codex/persistent-codex-service.js';

/**
 * Execute a Codex command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleCodexCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      try {
        const result = await codexSendPersistent(stdinData && stdinData.message !== undefined ? stdinData : {
          message: args[0] || '',
          threadId: args[1] || null,
          cwd: args[2] || null,
          permissionMode: args[3] || null,
          model: args[4] || null,
        });
        if (result.outcome !== 'completed') throw new Error(result.error || `Codex turn ${result.outcome}`);
      } finally {
        // channel-manager owns one command; its native child must not keep
        // the probe alive after completion. Daemon sends use a separate route.
        await codexShutdownPersistentRuntimes();
      }
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      const serverConfig = stdinData?.serverConfig || null;
      await codexGetMcpServerTools(serverId, serverConfig);
      break;
    }

    case 'listModels': {
      codexListModels();
      break;
    }

    default:
      throw new Error(`Unknown Codex command: ${command}`);
  }
}

export function getCodexCommandList() {
  return ['send', 'getMcpServerTools', 'listModels'];
}
