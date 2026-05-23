import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePermissionMode } from './permission-mode.js';
import {
  redactSecrets,
  truncateErrorContent,
  truncateString,
  truncateToolResultBlock
} from './message-output-filter.js';

test('normalizePermissionMode falls back to default for unknown values', () => {
  assert.equal(normalizePermissionMode(''), 'default');
  assert.equal(normalizePermissionMode('plan'), 'plan');
  assert.equal(normalizePermissionMode('unexpected-mode'), 'default');
});

test('truncateString and truncateErrorContent preserve short content', () => {
  assert.equal(truncateString('hello', 10), 'hello');
  assert.equal(truncateErrorContent('plain text', 5), 'plain text');
});

test('truncateErrorContent only truncates known error prefixes', () => {
  const longError = 'Error: ' + 'x'.repeat(40);
  const longPlain = 'Hello ' + 'y'.repeat(40);

  assert.match(truncateErrorContent(longError, 20), /\[truncated/);
  assert.equal(truncateErrorContent(longPlain, 20), longPlain);
});

test('truncateToolResultBlock truncates string and array payloads', () => {
  const longText = 'z'.repeat(25000);
  const stringBlock = { type: 'tool_result', content: longText };
  const arrayBlock = {
    type: 'tool_result',
    content: [{ type: 'text', text: longText }]
  };

  const truncatedStringBlock = truncateToolResultBlock(stringBlock);
  const truncatedArrayBlock = truncateToolResultBlock(arrayBlock);

  assert.notEqual(truncatedStringBlock.content, longText);
  assert.match(truncatedStringBlock.content, /truncated, original length/);
  assert.notEqual(truncatedArrayBlock.content[0].text, longText);
  assert.match(truncatedArrayBlock.content[0].text, /truncated, original length/);
});

test('redactSecrets masks Anthropic / OpenAI keys', () => {
  assert.match(
    redactSecrets('Auth failed: sk-ant-api03-abcdef1234567890abcdefABCDEF_XYZ'),
    /sk-ant-\*\*\*REDACTED\*\*\*/,
  );
  assert.match(
    redactSecrets('Failed call with key sk-proj-1234567890abcdef'),
    /sk-proj-\*\*\*REDACTED\*\*\*/,
  );
});

test('redactSecrets masks Bearer / Authorization / x-api-key headers', () => {
  const stderr = [
    'Authorization: Bearer abcdef1234567890XYZ',
    'x-api-key: sk-Real-KEY-1234567890',
    'api_key="another-secret-1234567890abcd"',
  ].join('\n');
  const cleaned = redactSecrets(stderr);
  assert.match(cleaned, /Bearer \*\*\*REDACTED\*\*\*/);
  assert.match(cleaned, /x-api-key:\s*\*\*\*REDACTED\*\*\*/i);
  assert.match(cleaned, /api_key="\*\*\*REDACTED\*\*\*/);
  assert.doesNotMatch(cleaned, /abcdef1234567890XYZ/);
});

test('redactSecrets masks GitHub tokens', () => {
  // Realistic GitHub token shapes (ghp_ classic ≥ 36 chars, github_pat_ fine-grained ≥ 80 chars)
  const text = 'fetch failed: ghp_1234567890abcdefABCDEF12345 / '
    + 'github_pat_11AAAAAAA0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijklmnopqrstuvwxyz';
  const cleaned = redactSecrets(text);
  // ghp_/gho_/ghs_ collapse to bare ***REDACTED*** (full mask)
  assert.match(cleaned, /fetch failed: \*\*\*REDACTED\*\*\* \//);
  // github_pat_ preserves its label
  assert.match(cleaned, /github_pat_\*\*\*REDACTED\*\*\*/);
  assert.doesNotMatch(cleaned, /1234567890abcdef/);
  assert.doesNotMatch(cleaned, /AAAAAAA0aBcDe/);
});

test('redactSecrets is a no-op for benign text', () => {
  assert.equal(redactSecrets('User-friendly error message'), 'User-friendly error message');
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
});
