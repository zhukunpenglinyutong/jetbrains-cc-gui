import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClaudeCommitPath, buildCommitAskRequest, askClaudeNonStreaming } from './commit-message.js';

// ---------- resolveClaudeCommitPath (#1655) ----------

test('resolveClaudeCommitPath picks ask path for real API key auth', () => {
  for (const authType of ['api_key', 'auth_token']) {
    assert.equal(
      resolveClaudeCommitPath({ apiKey: 'sk-test', authType }),
      'ask',
      `authType=${authType} should use the Anthropic ask path`,
    );
  }
});

test('resolveClaudeCommitPath picks agent path for CLI login (subscription OAuth)', () => {
  // setupApiKey() returns apiKey: '' + authType: 'cli_login' for CLI Login mode -
  // the exact shape that used to hard-fail with "No API key configured" (#1655).
  assert.equal(
    resolveClaudeCommitPath({ apiKey: '', authType: 'cli_login' }),
    'agent',
  );
});

test('resolveClaudeCommitPath picks agent path when no key is configured at all', () => {
  assert.equal(resolveClaudeCommitPath({ apiKey: null, authType: 'unknown' }), 'agent');
  assert.equal(resolveClaudeCommitPath(null), 'agent');
});

// ---------- buildCommitAskRequest (#1693) ----------

test('buildCommitAskRequest disables thinking so reasoning models still emit text', () => {
  const request = buildCommitAskRequest('deepseek-reasoner', 'write a commit message');
  // Reasoning models default to thinking and can spend the whole max_tokens
  // budget on `thinking` blocks, so no text_delta is ever emitted and the commit
  // message comes out empty. thinking must stay disabled on this path, and the
  // ceiling has to leave room for relays that ignore the flag.
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(request.model, 'deepseek-reasoner');
  assert.equal(request.max_tokens, 2048);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'write a commit message' }]);
});
// ---------- askClaudeNonStreaming (#1805) ----------

test('askClaudeNonStreaming uses the shared ask request shape', async () => {
  const requests = [];
  const client = {
    messages: {
      create: async (request) => {
        requests.push(request);
        return { content: [{ type: 'text', text: 'feat: add fallback' }] };
      },
    },
  };
  const text = await askClaudeNonStreaming(client, 'deepseek-reasoner', 'write a commit message');
  assert.equal(text, 'feat: add fallback');
  assert.equal(requests.length, 1);
  // The fallback exists precisely for DeepSeek, where a bare request returns
  // only thinking blocks (#1693) - it must keep thinking disabled and the
  // 2048 ceiling, same as the streaming ask path.
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(requests[0].max_tokens, 2048);
});

test('askClaudeNonStreaming retries once on empty text then gives up', async () => {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        return { content: [{ type: 'thinking', thinking: '...' }] };
      },
    },
  };
  const text = await askClaudeNonStreaming(client, 'deepseek-reasoner', 'prompt');
  assert.equal(text, '');
  assert.equal(calls, 2);
});
