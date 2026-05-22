/**
 * opencode message service.
 *
 * This first slice wires provider dispatch and SDK resolution. The actual
 * HTTP server/session/event bridge is implemented in the next slice.
 */
import { ensureOpenCodeSdk, normalizeOpenCodeSdkError } from './opencode-utils.js';

function emitSendError(errorPayload) {
  console.log('[SEND_ERROR] ' + JSON.stringify(errorPayload));
}

export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  permissionMode = '',
  model = '',
  agent = '',
  attachments = []
) {
  try {
    await ensureOpenCodeSdk();
    emitSendError({
      code: 'OPENCODE_NOT_IMPLEMENTED',
      error: 'opencode bridge is registered, but HTTP session streaming is not implemented yet.',
      details: {
        hasMessage: Boolean(message),
        sessionId,
        cwd,
        permissionMode,
        model,
        agent,
        attachmentCount: Array.isArray(attachments) ? attachments.length : 0
      }
    });
  } catch (error) {
    emitSendError(normalizeOpenCodeSdkError(error));
  }
}

export async function abortSession(sessionId = '') {
  console.log(JSON.stringify({
    success: false,
    error: 'opencode abort is not implemented yet.',
    sessionId
  }));
}
