import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignOpenCodeHistoryTurnIds,
  buildOpenCodeUsageStatistics,
  normalizeOpenCodeMessage,
  normalizeOpenCodeSessions,
  normalizeOpenCodeUsageForBridge
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

test('normalizes opencode usage for existing token indicator', () => {
  assert.deepEqual(normalizeOpenCodeUsageForBridge({
    input: 100,
    output: 20,
    reasoning: 5,
    cache: { read: 10, write: 15 }
  }, 1000), {
    input_tokens: 100,
    output_tokens: 25,
    cache_creation_input_tokens: 15,
    cache_read_input_tokens: 10,
    total_tokens: 150,
    context_window: 1000,
    max_tokens: 1000
  });
});

test('builds opencode usage statistics from session usage fields', () => {
  const now = Date.now();
  const stats = buildOpenCodeUsageStatistics([
    {
      id: 'ses_parent',
      title: 'Parent',
      directory: '/repo',
      time: { created: now - 1000, updated: now },
      model: { providerID: 'openai', id: 'gpt-5.5' },
      cost: 0.25,
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 10, write: 15 }
      }
    },
    {
      id: 'ses_child',
      parentID: 'ses_parent',
      time: { updated: now },
      cost: 99,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
    },
    {
      id: 'ses_empty',
      title: 'Empty',
      time: { updated: now },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    }
  ], '/repo', 0);

  assert.equal(stats.projectName, 'repo');
  assert.equal(stats.totalSessions, 1);
  assert.equal(stats.estimatedCost, 0.25);
  assert.equal(stats.totalUsage.totalTokens, 150);
  assert.equal(stats.totalUsage.outputTokens, 25);
  assert.equal(stats.sessions[0].model, 'openai/gpt-5.5');
  assert.equal(stats.byModel[0].sessionCount, 1);
  assert.equal(stats.dailyUsage[0].sessions, 1);
});
