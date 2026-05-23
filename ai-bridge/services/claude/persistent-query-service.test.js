import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';

test('abortCurrentTurn marks runtime as user-aborted before disposing it', async () => {
  let disposed = false;
  const runtime = {
    closed: false,
    sessionId: null,
    runtimeSessionEpoch: 'epoch-test',
    activeTurnCount: 1,
    inputStream: {
      done() {
        disposed = true;
      },
    },
    query: {
      close() {},
    },
  };

  __testing.setActiveTurnRuntime(runtime);

  await __testing.abortCurrentTurn();

  assert.equal(runtime.abortRequested, true);
  assert.equal(runtime.closed, true);
  assert.equal(disposed, true);
});
