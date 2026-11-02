import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonc, resolveModelFlag, resolveOpenCodeContextWindow } from './config.js';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cfg-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveOpenCodeContextWindow reads limit.context from opencode.json', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify({
        provider: {
          mlx: {
            models: {
              'local/Qwen3-Coder-30B-A3B-Instruct-Ternary2x': {
                limit: { context: 65536, output: 8192 },
              },
            },
          },
        },
        model: 'mlx/local/Qwen3-Coder-30B-A3B-Instruct-Ternary2x',
      }),
      'utf8'
    );
    assert.equal(resolveOpenCodeContextWindow('', dir, dir), 65536);
    assert.equal(
      resolveOpenCodeContextWindow('mlx/local/Qwen3-Coder-30B-A3B-Instruct-Ternary2x', dir, dir),
      65536
    );
  });
});

test('resolveOpenCodeContextWindow reads JSONC with comments and trailing commas', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'opencode.jsonc'), `{
  // local model via LM Studio
  "provider": {
    "lmstudio": {
      "options": { "baseURL": "http://localhost:1234/v1" },
      "models": {
        "qwen": { "limit": { "context": 32768, "output": 4096, }, },
      },
    },
  },
}
`, 'utf8');
    assert.equal(resolveOpenCodeContextWindow('lmstudio/qwen', dir, dir), 32768);
  });
});

test('parseJsonc leaves comment markers and commas inside strings untouched', () => {
  const parsed = parseJsonc('{ "url": "http://a/*b*/", "note": "x, }", /* gone */ "n": [1, 2,], }');
  assert.deepEqual(parsed, { url: 'http://a/*b*/', note: 'x, }', n: [1, 2] });
});

test('parseJsonc keeps escaped quotes inside strings', () => {
  assert.deepEqual(parseJsonc('{ "q": "say \\"hi\\", // not a comment", }'), { q: 'say "hi", // not a comment' });
});

test('resolveModelFlag maps config-default ids to null', () => {
  assert.equal(resolveModelFlag('__config_default__'), null);
  assert.equal(resolveModelFlag('  Default '), null);
  assert.equal(resolveModelFlag('openai/gpt-5'), 'openai/gpt-5');
});
