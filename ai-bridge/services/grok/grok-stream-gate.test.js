/**
 * Regression: multi-turn Grok must not paint prior-turn thought/text under the
 * new user bubble. STREAM_START / content events only open after prompt_phase_start.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrokEventNormalizer } from './grok-event-normalizer.js';

/**
 * Mirror of message-service onEvent gating (keep in sync with sendMessage).
 * Extracted here as a pure sequence test so we do not need to spawn grok agent.
 */
function createGatedNormalizerSink() {
  const lines = [];
  const normalizer = new GrokEventNormalizer({
    log: (...args) => lines.push(args.map(String).join(' ')),
    error: (...args) => lines.push(args.map(String).join(' ')),
  });
  let streamOpen = false;

  const onEvent = (type, payload) => {
    if (type === 'prompt_phase_start') {
      if (!streamOpen) {
        normalizer.begin();
        streamOpen = true;
      }
      return;
    }
    if (type === 'session_id') {
      normalizer.handleAcpEvent(type, payload);
      return;
    }
    if (!streamOpen) {
      return;
    }
    normalizer.handleAcpEvent(type, payload);
  };

  return { onEvent, lines, getStreamOpen: () => streamOpen, normalizer };
}

test('pre-prompt history notifications are dropped (no STREAM_START / no deltas)', () => {
  const { onEvent, lines, getStreamOpen } = createGatedNormalizerSink();

  onEvent('session_id', 'sess-1');
  // Simulate session/load replaying the previous assistant turn
  onEvent('notification', {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { text: 'The user is greeting me in Chinese with "你好啊"' },
      },
    },
  });
  onEvent('notification', {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: '你好！有什么我可以帮你的吗？' },
      },
    },
  });

  assert.equal(getStreamOpen(), false);
  assert.ok(
    lines.every((l) => !l.includes('[STREAM_START]') && !l.includes('[CONTENT_DELTA]') && !l.includes('[THINKING_DELTA]')),
    `pre-prompt must not emit stream tags, got: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((l) => l.includes('[SESSION_ID] sess-1')),
    'session_id must still be forwarded before prompt',
  );
});

test('post prompt_phase_start notifications stream into the normalizer', () => {
  const { onEvent, lines, getStreamOpen, normalizer } = createGatedNormalizerSink();

  onEvent('session_id', 'sess-2');
  onEvent('prompt_phase_start', {});
  assert.equal(getStreamOpen(), true);
  assert.ok(lines.some((l) => l.includes('[STREAM_START]')));

  onEvent('notification', {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { text: 'Thinking about the second greeting' },
      },
    },
  });
  onEvent('notification', {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: '第二轮回复' },
      },
    },
  });

  assert.ok(lines.some((l) => l.includes('[THINKING_DELTA]') && l.includes('second greeting')));
  assert.ok(lines.some((l) => l.includes('[CONTENT_DELTA]') && l.includes('第二轮回复')));
  assert.equal(normalizer.assistantText, '第二轮回复');
  assert.equal(normalizer.thinkingText, 'Thinking about the second greeting');
});

test('history chunks before prompt do not contaminate post-prompt buffers', () => {
  const { onEvent, normalizer } = createGatedNormalizerSink();

  // Prior turn content during session/load
  onEvent('notification', {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { text: 'PRIOR THINKING ABOUT 你好啊' },
      },
    },
  });
  onEvent('notification', {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'PRIOR ANSWER' },
      },
    },
  });

  onEvent('prompt_phase_start', {});
  onEvent('notification', {
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'ONLY NEW TURN' },
      },
    },
  });

  assert.equal(normalizer.assistantText, 'ONLY NEW TURN');
  assert.equal(normalizer.thinkingText, '');
});
