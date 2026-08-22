/**
 * DSH channel command handler — DeepSeek Harness speaks Host RPC +
 * WebSocket mux against a persistent local `dsh web`; no per-turn CLI spawn.
 */

import { sendMessage as dshSendMessage } from '../services/dsh/message-service.js';
import { listModels as dshListModels } from '../services/dsh/models-service.js';
import {
  deleteSessionCommand,
  listSessionsCommand,
  loadSessionCommand,
} from '../services/dsh/history-service.js';
import {
  collectDshStatus,
  ensureHost,
  runtimeSettingsFromEnv,
  stopSpawnedHost,
} from '../services/dsh/supervisor.js';

/**
 * Execute a DSH command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleDshCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        await dshSendMessage({
          message: stdinData.message,
          sessionId: stdinData.sessionId || '',
          cwd: stdinData.cwd || '',
          model: stdinData.model || '',
          reasoningEffort: stdinData.reasoningEffort || '',
          attachments: stdinData.attachments || [],
          preset: stdinData.preset || '',
        });
      } else {
        await dshSendMessage({
          message: args[0],
          sessionId: args[1],
          cwd: args[2],
          model: args[3],
          reasoningEffort: args[4],
          attachments: [],
          preset: '',
        });
      }
      break;
    }

    case 'listModels':
      await dshListModels();
      break;

    case 'listSessions':
      await listSessionsCommand({ cwd: (stdinData && stdinData.cwd) || process.cwd() });
      break;

    case 'loadSession':
      await loadSessionCommand({ sessionId: (stdinData && stdinData.sessionId) || args[0] || '' });
      break;

    case 'deleteSession':
      await deleteSessionCommand({ sessionId: (stdinData && stdinData.sessionId) || args[0] || '' });
      break;

    case 'status': {
      const status = await collectDshStatus(runtimeSettingsFromEnv());
      console.log(JSON.stringify(status));
      break;
    }

    case 'ensureHost': {
      try {
        const handle = await ensureHost(runtimeSettingsFromEnv());
        console.log(JSON.stringify({
          success: true,
          provider: 'dsh',
          origin: handle.origin,
          ownership: handle.ownership,
          describe: handle.describe,
        }));
      } catch (error) {
        console.log(JSON.stringify({ success: false, provider: 'dsh', error: error.message }));
      }
      break;
    }

    case 'stopHost': {
      const result = await stopSpawnedHost(runtimeSettingsFromEnv());
      console.log(JSON.stringify({ provider: 'dsh', ...result }));
      break;
    }

    default:
      throw new Error(`Unknown DSH command: ${command}`);
  }
}

export function getDshCommandList() {
  return [
    'send',
    'listModels',
    'listSessions',
    'loadSession',
    'deleteSession',
    'status',
    'ensureHost',
    'stopHost',
  ];
}
