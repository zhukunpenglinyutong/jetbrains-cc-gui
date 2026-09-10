/**
 * ZCode channel command handler – keeps ZCode-specific logic separated.
 *
 * ZCode has no npm SDK: a persistent `zcode app-server` child (stdio JSON-RPC)
 * is driven by services/zcode/persistent-zcode-service.js. In one-shot
 * channel-manager mode the same service runs a single turn, then the
 * app-server is torn down so the process can exit.
 */
import {
  sendMessagePersistent,
  getContextUsagePersistent,
  getUsagePersistent,
  shutdownPersistentRuntimes,
} from '../services/zcode/persistent-zcode-service.js';
import { listModels } from '../services/zcode/models-service.js';
import {
  listSessions,
  getSessionMessages,
  deleteSession,
} from '../services/zcode/history-service.js';

/**
 * Execute a ZCode command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleZcodeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      const payload = stdinData || {};
      try {
        await sendMessagePersistent(payload);
      } finally {
        // One-shot mode: drop the app-server child so the process can exit.
        await shutdownPersistentRuntimes();
      }
      break;
    }

    case 'listModels':
      listModels();
      break;

    case 'getContextUsage':
      await getContextUsagePersistent(stdinData || {});
      break;

    case 'getUsage':
      await getUsagePersistent(stdinData || {});
      break;

    case 'listSessions': {
      const cwd = (stdinData?.cwd || args[0] || process.cwd());
      const result = await listSessions(cwd);
      console.log(JSON.stringify(result));
      break;
    }

    case 'getSessionMessages': {
      const sessionId = stdinData?.sessionId || args[0] || '';
      const cwd = stdinData?.cwd || args[1] || process.cwd();
      if (!sessionId) throw new Error('getSessionMessages requires sessionId');
      const messages = await getSessionMessages(sessionId, cwd);
      console.log(JSON.stringify({ success: true, messages }));
      break;
    }

    case 'deleteSession': {
      const sessionId = stdinData?.sessionId || args[0] || '';
      if (!sessionId) throw new Error('deleteSession requires sessionId');
      const result = await deleteSession(sessionId);
      console.log(JSON.stringify(result));
      break;
    }

    default:
      throw new Error(`Unknown ZCode command: ${command}`);
  }
}

export function getZcodeCommandList() {
  return ['send', 'listModels', 'getContextUsage', 'getUsage', 'listSessions', 'getSessionMessages', 'deleteSession'];
}
