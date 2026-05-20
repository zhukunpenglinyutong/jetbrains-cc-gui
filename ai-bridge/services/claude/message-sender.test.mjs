import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './message-sender.js';

async function* messages(items) {
  for (const item of items) {
    yield item;
  }
}

test('forked retry path rejects when SDK returns the source session ID', async () => {
  await assert.rejects(
    __testing.executeWithRetry({
      createQueryResult: () => messages([
        { type: 'system', session_id: 'source-session' },
        { type: 'result', is_error: false }
      ]),
      streamingEnabled: false,
      resumeSessionId: 'source-session',
      forkSession: true,
      workingDirectory: process.cwd(),
      logPrefix: '',
      outerStreamState: { streamStarted: false, streamEnded: false, accumulatedUsage: null },
      userMessage: 'branch continuation'
    }),
    /Fork request completed without a new session ID/
  );
});

test('forked retry path resolves when SDK returns a new session ID', async () => {
  const outerStreamState = { streamStarted: false, streamEnded: false, accumulatedUsage: null };

  await __testing.executeWithRetry({
    createQueryResult: () => messages([
      { type: 'system', session_id: 'fork-session' },
      { type: 'result', is_error: false }
    ]),
    streamingEnabled: false,
    resumeSessionId: 'source-session',
    forkSession: true,
    workingDirectory: process.cwd(),
    logPrefix: '',
    outerStreamState,
    userMessage: 'branch continuation'
  });

  assert.equal(outerStreamState.streamEnded, false);
});
