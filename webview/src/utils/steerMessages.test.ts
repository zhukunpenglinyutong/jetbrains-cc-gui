import { describe, it, expect } from 'vitest';
import {
  buildSteeredUserMessage,
  clearSteerPending,
  getSteerIdOf,
  isSteerPending,
  removeSteeredMessage,
} from './steerMessages';
import { isSteeredUserMessage } from './turnScope';
import type { ClaudeMessage } from '../types';

const build = () => buildSteeredUserMessage(
  'steer text',
  [{ type: 'text', text: 'steer text' }],
  'steer-1',
  undefined,
  '2026-09-24T00:00:00.000Z',
);

describe('steerMessages', () => {
  it('builds a pending steered user bubble that counts as a steered row', () => {
    const message = build();

    expect(message).toMatchObject({
      type: 'user',
      content: 'steer text',
      steerId: 'steer-1',
      steered: true,
      steerPending: true,
      isOptimistic: true,
    });
    // The turn-scope helpers must treat it as a steered row so the scope stays
    // anchored on the original user message instead of restarting the turn.
    expect(isSteeredUserMessage(message)).toBe(true);
    expect(isSteerPending(message)).toBe(true);
    expect(getSteerIdOf(message)).toBe('steer-1');
  });

  it('leaves non-steer rows and other steer ids untouched', () => {
    const list: ClaudeMessage[] = [
      { type: 'user', content: 'plain' },
      build(),
    ];

    expect(removeSteeredMessage(list, 'other')).toBe(list);
    expect(clearSteerPending(list, 'other')).toBe(list);
    expect(getSteerIdOf(list[0])).toBeUndefined();
    expect(isSteerPending(list[0])).toBe(false);
  });

  it('carries the original attachments on the bubble for receipt recovery', () => {
    // Steer plan F1: attachment content blocks carry only the file name, so
    // the queued attachments must ride verbatim on the raw for an
    // undelivered/rejected receipt to rebuild the queue row.
    const attachments = [{ id: 'att-1', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' }];
    const message = buildSteeredUserMessage(
      'steer text',
      [{ type: 'text', text: 'steer text' }],
      'steer-1',
      attachments,
    );

    expect(message.raw).toMatchObject({ steerAttachments: attachments });
    // No attachments → the recovery field stays off the raw entirely.
    expect(buildSteeredUserMessage('t', [{ type: 'text', text: 't' }], 'steer-2').raw).not.toHaveProperty('steerAttachments');
  });

  it('removes the pending bubble by steer id', () => {
    const list: ClaudeMessage[] = [{ type: 'assistant', content: 'seg 1' }, build()];

    const next = removeSteeredMessage(list, 'steer-1');

    expect(next).toHaveLength(1);
    expect(next[0].type).toBe('assistant');
  });

  it('clears the pending marker once the CLI folded the steer', () => {
    const list: ClaudeMessage[] = [{ type: 'assistant', content: 'seg 1' }, build()];

    const next = clearSteerPending(list, 'steer-1');

    expect(next[1]).toMatchObject({ steerPending: false, isOptimistic: false, steered: true });
    // Still a steered row, so rewind stays hidden on it.
    expect(isSteeredUserMessage(next[1])).toBe(true);
  });
});
