/**
 * DSH cancel command: ask the host to cancel one active turn.
 *
 * Runs as its own short-lived process so the plugin can cancel before it
 * force-kills the send process (Windows gives that process no chance to react).
 * Attaches to an existing host only; never spawns one.
 */

import { connectExisting, runtimeSettingsFromEnv } from './supervisor.js';
import { cancel, sessionIdFromThread } from './session.js';

/**
 * @param {object} options
 * @param {string} options.sessionId
 * @param {Function} [options.connect]
 * @param {Function} [options.cancelSession]
 * @returns {Promise<object>} the JSON result written to stdout by the caller
 */
export async function cancelSession({
  sessionId,
  connect = connectExisting,
  cancelSession: cancelRpc = cancel,
}) {
  const id = sessionIdFromThread(sessionId);
  if (!id) {
    return { success: false, provider: 'dsh', error: 'sessionId is required' };
  }
  try {
    const { client } = await connect(runtimeSettingsFromEnv());
    await cancelRpc(client, id);
    return { success: true, provider: 'dsh', sessionId: id };
  } catch (error) {
    return { success: false, provider: 'dsh', sessionId: id, error: `dsh session.cancel failed: ${error.message}` };
  }
}

/** channel command: cancel the active turn of a session. */
export async function cancelSessionCommand({ sessionId }) {
  console.log(JSON.stringify(await cancelSession({ sessionId })));
}
