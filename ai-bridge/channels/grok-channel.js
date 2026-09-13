/**
 * Grok channel command handler.
 * Claude-shaped stdin contract; ACP primary via services/grok.
 */

import { sendMessage as grokSendMessage } from '../services/grok/message-service.js';
import { listModels as grokListModels } from '../services/grok/models-service.js';
import {
  getGrokReasoningSupportedModels,
  buildGrokContextUsagePayload,
} from '../services/grok/grok-utils.js';

export async function handleGrokCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && (stdinData.message !== undefined || stdinData.prompt !== undefined)) {
        const options = {
          message: stdinData.message ?? stdinData.prompt ?? '',
          sessionId: stdinData.sessionId || '',
          cwd: stdinData.cwd || '',
          permissionMode: stdinData.permissionMode || '',
          model: stdinData.model || '',
          baseUrl: stdinData.baseUrl || '',
          apiKey: stdinData.apiKey || '',
          authMethod: stdinData.authMethod || '',
          attachments: stdinData.attachments || [],
          // Claude-shaped fields
          openedFiles: stdinData.openedFiles ?? null,
          agentPrompt: stdinData.agentPrompt || '',
          streaming: stdinData.streaming !== undefined ? stdinData.streaming : true,
          reasoningEffort: stdinData.reasoningEffort || '',
        };
        await grokSendMessage(options);
      } else {
        // Legacy positional fallback
        await grokSendMessage(
          args[0],
          args[1],
          args[2],
          args[3],
          args[4],
          args[5],
          args[6]
        );
      }
      break;
    }

    case 'listModels': {
      grokListModels();
      break;
    }

    case 'getContextUsage': {
      // One-shot path: synthesize from Java-supplied used/max when present.
      const payload = buildGrokContextUsagePayload({
        usedTokens: stdinData?.usedTokens ?? 0,
        maxTokens: stdinData?.maxTokens ?? 200_000,
        model: stdinData?.model || '',
      });
      console.log(JSON.stringify(payload));
      break;
    }
    case 'getUsage': {
      // One-shot path: structured unavailable (billing needs auth/daemon).
      console.log(JSON.stringify({
        success: true,
        data: {
          unavailable: true,
          message:
            'Grok billing snapshot requires the persistent daemon. Use /usage in chat or open a Grok session first.',
          source: 'channel-fallback',
        },
      }));
      break;
    }
    case 'getReasoningSupportedModels': {
      // Dynamic lookup from ~/.grok/models_cache.json
      const supported = getGrokReasoningSupportedModels();
      console.log(JSON.stringify({
        success: true,
        supportedModels: supported
      }));
      break;
    }
    default:
      throw new Error(`Unknown Grok command: ${command}`);
  }
}

export function getGrokCommandList() {
  return ['send', 'listModels', 'getContextUsage', 'getUsage', 'getReasoningSupportedModels'];
}
