/**
 * Gemini / Antigravity CLI message service.
 * Claude-shaped stdin contract; headless agy stream-json transport.
 */

import { runAgyTurn } from './agy-runner.js';
import { AgyEventNormalizer } from './agy-event-normalizer.js';
import { buildErrorPayload, isAgyAvailable, resolveAgyBinary } from './agy-utils.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';

/**
 * @param {object|string} messageOrOptions Claude-shaped options bag or plain message
 */
export async function sendMessage(messageOrOptions, sessionId = '', cwd = '', permissionMode = '', model = '') {
  const opts =
    messageOrOptions && typeof messageOrOptions === 'object' && !Array.isArray(messageOrOptions)
      ? messageOrOptions
      : {
          message: messageOrOptions,
          sessionId,
          cwd,
          permissionMode,
          model,
        };

  const {
    message = '',
    sessionId: sid = '',
    cwd: workCwd = '',
    permissionMode: perm = '',
    model: modelId = '',
    agentPrompt = '',
    reasoningEffort = '',
    agent = '',
    printTimeout = '',
  } = opts;

  const normalizer = new AgyEventNormalizer({
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
  });

  try {
    if (!isAgyAvailable()) {
      throw new Error(
        'Antigravity CLI (agy) not found. Install: https://antigravity.google/docs/cli/install '
        + 'or set AGY_PATH to the binary.'
      );
    }

    const guardedCwd = selectWorkingDirectory(workCwd);

    console.error('[DEBUG] Gemini/agy sendMessage:', {
      bin: resolveAgyBinary(),
      hasSessionId: !!sid,
      cwd: guardedCwd || '(current)',
      model: modelId || '(default)',
      permissionMode: perm || '(default)',
      reasoningEffort: reasoningEffort || '(none)',
      hasAgentPrompt: !!agentPrompt,
    });

    normalizer.begin();

    // Optional agent role preamble (agy has no separate system prompt flag in headless)
    let finalMessage = String(message ?? '').trim();
    if (agentPrompt && String(agentPrompt).trim()) {
      finalMessage = finalMessage
        ? `${finalMessage}\n\n## Agent Role and Instructions\n\n${agentPrompt}`
        : `## Agent Role and Instructions\n\n${agentPrompt}`;
    }

    if (!finalMessage.trim()) {
      if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
        finalMessage = 'Please analyze the attached content.';
      } else {
        finalMessage = 'Continue';
      }
    }

    const turn = await runAgyTurn({
      message: finalMessage,
      sessionId: sid,
      cwd: guardedCwd,
      model: modelId,
      reasoningEffort,
      agent,
      permissionMode: perm,
      printTimeout,
      onEvent: (obj) => normalizer.handleStreamEvent(obj),
      onStderr: (chunk) => {
        const s = String(chunk || '').trim();
        if (s) console.error('[AGY]', s.slice(0, 500));
      },
    });

    const st = String(turn.status || '').toUpperCase();
    const text = turn.response || normalizer.assistantText || '';

    if (st && st !== 'SUCCESS' && !text) {
      throw new Error(turn.error || `agy status=${st}`);
    }

    if (st && st !== 'SUCCESS' && text) {
      console.error('[AGY] terminal status', st, turn.error || '');
    }

    normalizer.finishSuccess(turn.conversationId || sid, text);
  } catch (error) {
    console.error('[DEBUG] Gemini/agy error:', error?.message || error);
    normalizer.finishError(error);
  }
}

export { buildErrorPayload };
