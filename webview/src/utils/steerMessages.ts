/**
 * Pure helpers for the optimistic steer bubble.
 *
 * A steered queued message is inserted into the transcript the moment the user
 * clicks the steer button, not when the CLI folds it into the live turn. The
 * bubble therefore carries a runtime-only `steerPending` flag until the fold
 * receipt (or a rejected/undelivered receipt) resolves it, so the UI never
 * claims the model has already read a message that is still waiting for the
 * next tool boundary.
 */

import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage } from '../types';
import type { QueuedMessage } from '../hooks/useMessageQueue';

/**
 * Read the frontend correlation id of a steer bubble.
 *
 * @param message candidate message
 * @returns steer id, or undefined when the message is not steer-related
 */
export function getSteerIdOf(message: ClaudeMessage): string | undefined {
  if (message.type !== 'user') return undefined;
  if (typeof message.steerId === 'string') return message.steerId;
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  return typeof raw.steerId === 'string' ? raw.steerId : undefined;
}

/**
 * True while the CLI has not yet folded this steer into the live turn.
 *
 * @param message candidate message
 * @returns whether the bubble is still awaiting delivery
 */
export function isSteerPending(message: ClaudeMessage): boolean {
  return message.type === 'user' && message.steerPending === true;
}

/**
 * Build the optimistic steered user bubble. Mirrors the payload shape of a
 * normally sent user message so the fold/history copies dedup against it.
 *
 * `attachments` (when present) is stored verbatim on the bubble so an
 * undelivered/rejected receipt can rebuild the queue row after the steering
 * map lost it (steer plan F1) — attachment content blocks carry only the
 * file name, not the data.
 *
 * @param text               display text
 * @param contentBlocks      text/image/attachment blocks
 * @param steerId            frontend correlation id
 * @param attachments        original queued attachments, if any
 * @param timestamp          ISO timestamp, defaults to now
 * @returns the optimistic steered user message
 */
export function buildSteeredUserMessage(
  text: string,
  contentBlocks: ClaudeContentBlock[],
  steerId: string,
  attachments?: QueuedMessage['attachments'],
  timestamp?: string,
): ClaudeMessage {
  const raw: ClaudeRawMessage = {
    steerId,
    steered: true,
    message: { content: contentBlocks },
    ...(attachments && attachments.length > 0 ? { steerAttachments: attachments } : {}),
  };
  return {
    type: 'user',
    content: text,
    timestamp: timestamp ?? new Date().toISOString(),
    // `isOptimistic` lets the existing snapshot merge guards keep the bubble
    // alive while the backend has no copy of it yet.
    isOptimistic: true,
    steered: true,
    steerId,
    steerPending: true,
    raw,
  };
}

/**
 * Drop a steered bubble after a rejected/undelivered receipt.
 *
 * @param list    current message list
 * @param steerId frontend correlation id
 * @returns a new list without the bubble, or the input list when absent
 */
export function removeSteeredMessage(list: ClaudeMessage[], steerId: string): ClaudeMessage[] {
  const next = list.filter((message) => getSteerIdOf(message) !== steerId);
  return next.length === list.length ? list : next;
}

/**
 * The CLI folded the steer: the bubble is now a delivered part of the turn.
 *
 * @param list    current message list
 * @param steerId frontend correlation id
 * @returns a new list with the pending marker cleared, or the input list
 */
export function clearSteerPending(list: ClaudeMessage[], steerId: string): ClaudeMessage[] {
  let changed = false;
  const next = list.map((message) => {
    if (!isSteerPending(message) || getSteerIdOf(message) !== steerId) return message;
    changed = true;
    return { ...message, steerPending: false, isOptimistic: false };
  });
  return changed ? next : list;
}
