import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePermissionMode } from './permission-mode.js';
import {
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
