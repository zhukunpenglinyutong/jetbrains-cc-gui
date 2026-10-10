import assert from 'node:assert/strict';
import test from 'node:test';
import { redactCodexDiagnostic } from './codex-diagnostics.js';

test('diagnostics scrub launch credentials, headers and recognizable structured answers', () => {
  assert.equal(redactCodexDiagnostic('server refused synthetic-token', ['synthetic-token']), 'server refused [redacted credential]');
  const text = redactCodexDiagnostic('Authorization=token sk-test123 Bearer another-token');
  for (const secret of ['token sk-', 'sk-test123', 'another-token']) assert.equal(text.includes(secret), false);
  assert.equal(redactCodexDiagnostic('{"answers":{"secret-q":{"answers":["synthetic-answer"]}}}').includes('synthetic-answer'), false);
  assert.equal(redactCodexDiagnostic('unrelated failure'), 'unrelated failure');
});
