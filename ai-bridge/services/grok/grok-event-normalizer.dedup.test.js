/**
 * Grok snapshot-delta dedup tests.
 *
 * The Grok CLI frequently re-sends the full accumulated text (snapshot) in
 * agent_message_chunk / thought updates instead of only the new part. The
 * normalizer must convert snapshots into true deltas and never duplicate or
 * resurrect already-streamed text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GrokEventNormalizer } from './grok-event-normalizer.js';

function recorder() {
  const lines = [];
  const n = new GrokEventNormalizer({
    log: (line) => lines.push(String(line)),
    error: () => {},
  });
  n.begin();
  return { n, lines };
}

const deltas = (lines, tag) =>
  lines
    .filter((l) => l.startsWith(tag))
    .map((l) => JSON.parse(l.slice(tag.length)));

describe('snapshot-delta dedup', () => {
  it('emits only the new part of snapshot-style message chunks', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, wor' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, world!' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['Hello', ', wor', 'ld!']);
  });

  it('ignores stale snapshot replays', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, world!' } },
    });
    // Earlier snapshot re-sent after the final one — nothing new may be emitted.
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, wor' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['Hello, world!']);
  });

  it('concatenates genuine delta chunks that are not snapshots', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', delta: 'foo' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', delta: 'bar' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['foo', 'bar']);
  });

  it('dedups thought snapshots into THINKING_DELTA', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'Think' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'Thinking hard' } },
    });

    assert.deepEqual(deltas(lines, '[THINKING_DELTA] '), ['Think', 'ing hard']);
    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), []);
  });

  it('keeps content and thinking accumulators independent', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'answer' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'reasoning' } },
    });
    // Thought snapshot must not be treated as an extension of the answer text.
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'reasoning' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['answer', 'reasoning']);
    assert.deepEqual(deltas(lines, '[THINKING_DELTA] '), ['reasoning']);
  });

  it('extracts text from nested and array content shapes', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { content: { text: 'deep' } },
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: [{ text: 'er ' }, { content: 'combo' }],
        },
      },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['deep', 'er combo']);
  });
});
