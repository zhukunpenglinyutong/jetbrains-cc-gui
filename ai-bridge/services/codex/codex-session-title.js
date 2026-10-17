import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemossDir } from '../../utils/path-utils.js';
import { isTitleGenerationEnabled, SESSION_TITLE_PROMPT } from '../session-title-service.js';

async function readCustomTitle(threadId) {
  try {
    const titles = JSON.parse(await readFile(join(getCodemossDir(), 'session-titles.json'), 'utf8'));
    return titles?.[threadId]?.customTitle || null;
  } catch {
    return null;
  }
}

/** Name only an unnamed, still-owned thread; title failures never fail the user turn. */
export async function settleCodexSessionTitle({
  service, threadId, userMessage, canApply, generateText,
}, { enabled = isTitleGenerationEnabled, readCustomTitle: customTitle = readCustomTitle } = {}) {
  try {
    if (!threadId || !userMessage?.trim() || !canApply() || !await enabled()) return;
    if (!canApply() || await customTitle(threadId)) return;
    const unnamed = async () => {
      if (!canApply()) return false;
      const result = await service.readOnly('thread/read', { threadId, includeTurns: false });
      return canApply() && result.thread?.id === threadId && !result.thread?.name?.trim();
    };
    if (!await unnamed()) return;
    const response = await generateText({ prompt: userMessage.slice(0, 1000),
      developerInstructions: SESSION_TITLE_PROMPT, effort: 'low' });
    if (!canApply()) return;
    const body = String(response).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const title = JSON.parse(body)?.title;
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 50 || /[\r\n]/.test(title)) return;
    // The user can rename the thread while the auxiliary request is running.
    if (await customTitle(threadId) || !await unnamed()) return;
    if (canApply()) await service.setThreadName(threadId, title.trim());
  } catch {
    // Optional naming must never interrupt the user's conversation.
  }
}
