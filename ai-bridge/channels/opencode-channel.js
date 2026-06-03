/**
 * opencode channel command handler.
 */
import {
  abortSession as openCodeAbortSession,
  deleteSession as openCodeDeleteSession,
  getMcpServerTools as openCodeGetMcpServerTools,
  getSessionMessages as openCodeGetSessionMessages,
  listAgents as openCodeListAgents,
  listCommands as openCodeListCommands,
  listMcpServerStatus as openCodeListMcpServerStatus,
  listMcpServers as openCodeListMcpServers,
  listSessions as openCodeListSessions,
  usageStatistics as openCodeUsageStatistics,
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
  const options = {
    persistentRuntime: stdinData?.persistentRuntime === true
  };

  switch (command) {
    case 'send': {
      const {
        message = args[0] || '',
        sessionId = args[1] || '',
        cwd = args[2] || '',
        permissionMode = args[3] || '',
        model = args[4] || '',
        agent = '',
        attachments = [],
        variant = ''
      } = stdinData || {};

      await openCodeSendMessage(
        message,
        sessionId,
        cwd,
        permissionMode,
        model,
        agent,
        attachments,
        options,
        variant
      );
      break;
    }

    case 'abort': {
      const sessionId = stdinData?.sessionId || args[0] || '';
      const cwd = stdinData?.cwd || args[1] || '';
      await openCodeAbortSession(sessionId, cwd, options);
      break;
    }

    case 'deleteSession': {
      const sessionId = stdinData?.sessionId || args[0] || '';
      const cwd = stdinData?.cwd || args[1] || '';
      await openCodeDeleteSession(sessionId, cwd, options);
      break;
    }

    case 'getSessionMessages': {
      const sessionId = stdinData?.sessionId || args[0] || '';
      const cwd = stdinData?.cwd || args[1] || '';
      await openCodeGetSessionMessages(sessionId, cwd, options);
      break;
    }

    case 'listModels': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListModels(cwd, options);
      break;
    }

    case 'listSessions': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListSessions(cwd, options);
      break;
    }

    case 'usageStatistics': {
      const cwd = stdinData?.cwd || args[0] || 'all';
      const scope = stdinData?.scope || args[1] || 'current';
      const cutoffTime = stdinData?.cutoffTime || args[2] || 0;
      await openCodeUsageStatistics(cwd, scope, cutoffTime, options);
      break;
    }

    case 'listAgents': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListAgents(cwd, options);
      break;
    }

    case 'listCommands': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListCommands(cwd, options);
      break;
    }

    case 'listMcpServers': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListMcpServers(cwd, options);
      break;
    }

    case 'listMcpServerStatus': {
      const cwd = stdinData?.cwd || args[0] || '';
      await openCodeListMcpServerStatus(cwd, options);
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || '';
      const cwd = stdinData?.cwd || args[1] || '';
      await openCodeGetMcpServerTools(serverId, cwd, options);
      break;
    }

    default:
      throw new Error(`Unknown opencode command: ${command}`);
  }
}

export function getOpenCodeCommandList() {
  return ['send', 'abort', 'deleteSession', 'getSessionMessages', 'listSessions', 'usageStatistics', 'listModels', 'listAgents', 'listCommands', 'listMcpServers', 'listMcpServerStatus', 'getMcpServerTools'];
}
