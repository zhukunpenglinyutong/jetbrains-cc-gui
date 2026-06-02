import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignOpenCodeHistoryTurnIds,
  normalizeOpenCodeMessage,
  normalizeOpenCodeSessions
} from './message-service.js';

test('normalizes opencode sessions for the history sidebar', () => {
  const sessions = normalizeOpenCodeSessions([
    {
      id: 'ses_older',
      title: 'Older session',
      directory: '/repo',
      time: { created: 1700000000000, updated: 1700000001000 },
      model: { providerID: 'openai', id: 'gpt-5.5' },
      agent: 'build'
    },
    {
      id: 'ses_newer',
      title: 'Newer session',
      directory: '/repo',
      time: { created: 1700000002000, updated: 1700000003000 }
    }
  ], new Map([
    ['ses_older', 4],
    ['ses_newer', 2]
  ]));

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 'ses_newer');
  assert.equal(sessions[0].provider, 'opencode');
  assert.equal(sessions[0].messageCount, 2);
  assert.equal(sessions[1].sessionId, 'ses_older');
  assert.equal(sessions[1].opencode.model.providerID, 'openai');
});

test('filters child opencode task sessions from root history', () => {
  const sessions = normalizeOpenCodeSessions([
    {
      id: 'ses_parent',
      title: 'Parent',
      time: { updated: 10 }
    },
    {
      id: 'ses_child',
      title: 'Child',
      parentID: 'ses_parent',
      time: { updated: 20 }
    }
  ]);

  assert.deepEqual(sessions.map((session) => session.sessionId), ['ses_parent']);
});

test('deduplicates opencode history sessions by session id', () => {
  const sessions = normalizeOpenCodeSessions([
    {
      id: 'ses_dup',
      title: 'Old duplicate',
      time: { updated: 10 }
    },
    {
      id: 'ses_dup',
      title: 'New duplicate',
      time: { updated: 20 }
    }
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'New duplicate');
});

test('assigns unique negative turn ids to restored opencode assistant steps', () => {
  const messages = assignOpenCodeHistoryTurnIds([
    { type: 'user', message: { content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'first response' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', text: '[tool_result]' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'after tool' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'second response' }] } }
  ]);

  assert.deepEqual(messages.map((message) => message.message.__turnId), [undefined, -3, undefined, -2, undefined, -1]);
  assert.equal(messages.some((message) => message.message.__turnId === 0), false);
});

test('normalizes opencode message id as stable uuid for history rendering', () => {
  const message = normalizeOpenCodeMessage({
    info: {
      id: 'msg_123',
      role: 'assistant'
    },
    parts: [
      { type: 'text', text: 'hello' }
    ]
  });

  assert.equal(message.uuid, 'msg_123');
  assert.equal(message.message.id, 'msg_123');
});
