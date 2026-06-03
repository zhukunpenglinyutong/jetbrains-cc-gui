import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventContext, handleOpenCodeEvent } from './message-service.js';

async function captureBridgeOutput(fn) {
  const originalLog = console.log;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) lines.push(line);
    }
    return true;
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return lines;
}

const knownOpenCodeEvents = [
  { type: 'session.status', behavior: 'handled' },
  { type: 'session.idle', behavior: 'handled' },
  { type: 'message.updated', behavior: 'handled' },
  { type: 'message.part.delta', behavior: 'handled' },
  { type: 'message.part.updated', behavior: 'handled' },
  { type: 'session.diff', behavior: 'handled' },
  { type: 'session.error', behavior: 'handled' },
  { type: 'permission.asked', behavior: 'handled' },
  { type: 'question.asked', behavior: 'handled' },
  { type: 'message.part.removed', behavior: 'ignored', reason: 'no corresponding visible block removal UI yet' },
  { type: 'permission.replied', behavior: 'ignored', reason: 'plugin replies immediately and has no footer queue' },
  { type: 'question.replied', behavior: 'ignored', reason: 'plugin replies immediately and has no footer queue' },
  { type: 'question.rejected', behavior: 'ignored', reason: 'plugin replies immediately and has no footer queue' },
  { type: 'todo.updated', behavior: 'ignored', reason: 'no opencode todo-list UI mapping yet' },
  { type: 'session.next.shell.started', behavior: 'ignored', reason: 'direct run shell events are separate from prompt tool parts' },
  { type: 'session.next.shell.ended', behavior: 'ignored', reason: 'direct run shell events are separate from prompt tool parts' },
];

test('opencode upstream event coverage matrix is explicit', () => {
  assert.equal(knownOpenCodeEvents.every((entry) => entry.type && entry.behavior), true);
  assert.equal(knownOpenCodeEvents.some((entry) => entry.behavior === 'ignored' && !entry.reason), false);
});

test('opencode intentionally ignored upstream events stay quiet', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const ignoredEvents = knownOpenCodeEvents.filter((entry) => entry.behavior === 'ignored');

  const lines = await captureBridgeOutput(async () => {
    for (const entry of ignoredEvents) {
      await handleOpenCodeEvent({
        type: entry.type,
        properties: {
          sessionID: 'ses_test',
          requestID: 'req_1',
          callID: 'call_1',
          partID: 'part_1',
          part: {
            id: 'part_1',
            sessionID: 'ses_test',
            messageID: 'msg_1',
            type: 'text',
            text: 'removed text'
          }
        }
      }, ctx);
    }
  });

  assert.deepEqual(lines, []);
});
