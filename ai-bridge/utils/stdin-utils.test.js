/**
 * Tests for the stdin gate contract (Story 1.2 review patch R-13).
 *
 * Every CLI provider's Java bridge flips its own `<PROVIDER>_USE_STDIN=true`
 * env var; channel-manager passes the provider id to `readStdinData`, which
 * looks the key up here. A typo in the map silently disables the stdin path
 * for that provider (the channel then falls back to positional argv and the
 * JSON payload — including `requestedCwd` — never arrives), so the gemini key
 * is pinned by an explicit test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stdinEnvKeyForProvider } from './stdin-utils.js';

test('gemini stdin gate is GEMINI_USE_STDIN (R-13)', () => {
  assert.equal(stdinEnvKeyForProvider('gemini'), 'GEMINI_USE_STDIN');
});

test('every bundled CLI provider maps to its own <PROVIDER>_USE_STDIN key', () => {
  for (const provider of ['grok', 'kimi', 'opencode', 'pi', 'omp', 'dsh']) {
    assert.equal(
      stdinEnvKeyForProvider(provider),
      `${provider.toUpperCase()}_USE_STDIN`,
      provider
    );
  }
});

test('the SDK providers and unknown ids fall back to the claude/codex keys', () => {
  assert.equal(stdinEnvKeyForProvider('claude'), 'CLAUDE_USE_STDIN');
  assert.equal(stdinEnvKeyForProvider('codex'), 'CODEX_USE_STDIN');
  assert.equal(stdinEnvKeyForProvider(''), 'CLAUDE_USE_STDIN');
  assert.equal(stdinEnvKeyForProvider(undefined), 'CLAUDE_USE_STDIN');
  assert.equal(stdinEnvKeyForProvider('no-such-provider'), 'CLAUDE_USE_STDIN');
});
