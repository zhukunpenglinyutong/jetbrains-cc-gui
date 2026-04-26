import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCodexCliEnvironment } from './codex-utils.js';

test('buildCodexCliEnvironment removes inherited Codex/OpenAI auth and endpoint variables', () => {
  const { cliEnv, removedKeys } = buildCodexCliEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    CODEX_API_KEY: 'sk-old-codex',
    CODEX_API_BASE: 'https://old-codex.example/v1',
    CODEX_BASE_URL: 'https://old-codex-base.example/v1',
    OPENAI_API_KEY: 'sk-old-openai',
    OPENAI_API_BASE: 'https://old-openai-api-base.example/v1',
    OPENAI_BASE_URL: 'https://old-openai-base.example/v1',
    OPENAI_ORG_ID: 'org-old',
    OPENAI_ORGANIZATION: 'org-old-name',
    OPENAI_PROJECT: 'proj-old',
    CODEX_APPROVAL_POLICY: 'never',
    CODEX_SANDBOX_MODE: 'danger-full-access',
  });

  assert.equal(cliEnv.PATH, '/usr/bin');
  assert.equal(cliEnv.HOME, '/tmp/home');
  assert.equal(cliEnv.CODEX_API_KEY, undefined);
  assert.equal(cliEnv.OPENAI_API_KEY, undefined);
  assert.equal(cliEnv.CODEX_API_BASE, undefined);
  assert.equal(cliEnv.OPENAI_BASE_URL, undefined);
  assert.deepEqual(
    new Set(removedKeys),
    new Set([
      'CODEX_API_KEY',
      'CODEX_API_BASE',
      'CODEX_BASE_URL',
      'OPENAI_API_KEY',
      'OPENAI_API_BASE',
      'OPENAI_BASE_URL',
      'OPENAI_ORG_ID',
      'OPENAI_ORGANIZATION',
      'OPENAI_PROJECT',
      'CODEX_APPROVAL_POLICY',
      'CODEX_SANDBOX_MODE',
    ])
  );
});
