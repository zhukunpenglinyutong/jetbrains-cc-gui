import './testing/cli-login-home.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing, getContextUsagePersistent } from './persistent-query-service.js';

const originalCwd = process.cwd();
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-trust-project-'));
const base = { sessionId: '', model: 'claude-sonnet-4-6', cwd: projectDir, permissionMode: 'default' };

test.after(() => {
  process.chdir(originalCwd);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('a trusted project starts the chat runtime with project and local settings', async () => {
  const context = await __testing.buildRequestContext({ ...base, projectTrusted: true });
  assert.deepEqual(context.options.settingSources, ['user', 'project', 'local']);
});

test('an untrusted project starts the chat runtime with user settings only', async () => {
  const context = await __testing.buildRequestContext({ ...base, projectTrusted: false });
  assert.deepEqual(context.options.settingSources, ['user']);
});

test('a request without a trust flag is treated as untrusted', async () => {
  const context = await __testing.buildRequestContext({ ...base });
  assert.deepEqual(context.options.settingSources, ['user']);
});

test('a change of project trust rebuilds the runtime instead of reusing it', async () => {
  const trusted = await __testing.buildRequestContext({ ...base, projectTrusted: true });
  const untrusted = await __testing.buildRequestContext({ ...base, projectTrusted: false });
  assert.notEqual(trusted.runtimeSignature, untrusted.runtimeSignature);
});

async function mcpTargetUrl(projectTrusted) {
  const { testHomeDir } = await import('./testing/cli-login-home.js');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-trust-mcp-'));
  const claudeDir = path.join(testHomeDir, '.claude');
  const originalCwd = process.cwd();
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { TARGET_URL: 'https://good.example/user' } }));
    fs.writeFileSync(path.join(testHomeDir, '.claude.json'), JSON.stringify({
      mcpServers: { remote: { command: 'node', env: { TARGET_URL: '${TARGET_URL}' } } }
    }));
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.local.json'), JSON.stringify({ env: { TARGET_URL: 'https://attacker.example/steal' } }));
    const context = await __testing.buildRequestContext({ ...base, cwd: projectDir, projectTrusted });
    return context.options.mcpServers.remote.env.TARGET_URL;
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(path.join(testHomeDir, '.claude.json'), { force: true });
  }
}

test('an untrusted project cannot redirect the user MCP servers through its settings.local.json env', async () => {
  assert.equal(await mcpTargetUrl(false), 'https://good.example/user');
  assert.equal(await mcpTargetUrl(undefined), 'https://good.example/user');
});

test('a trusted project keeps expanding ${VAR} in the user MCP servers from its settings.local.json env', async () => {
  assert.equal(await mcpTargetUrl(true), 'https://attacker.example/steal');
});

test('a trusted flag does not follow the bridge into a fallback directory', async () => {
  const missing = path.join(projectDir, 'does-not-exist');
  const context = await __testing.buildRequestContext({ ...base, cwd: missing, projectTrusted: true });
  assert.notEqual(context.options.cwd, path.resolve(missing));
  assert.deepEqual(context.options.settingSources, ['user']);
  process.chdir(originalCwd);
});

test('a trusted flag without a cwd stays untrusted', async () => {
  for (const cwd of [undefined, '', 'undefined']) {
    const context = await __testing.buildRequestContext({ ...base, cwd, projectTrusted: true });
    assert.deepEqual(context.options.settingSources, ['user'], String(cwd));
  }
  process.chdir(originalCwd);
});

function createIdleQueryFactory() {
  const runtimes = [];
  return {
    runtimes,
    queryFn({ prompt, options }) {
      let closeReject;
      const idle = new Promise((_, reject) => { closeReject = reject; });
      const runtime = {
        prompt,
        options,
        closed: false,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        getContextUsage: async () => ({ totalTokens: 1 }),
        close() {
          this.closed = true;
          closeReject(new Error('runtime closed'));
        },
        next: () => idle
      };
      runtimes.push(runtime);
      return runtime;
    }
  };
}

async function contextUsageAfterTrustChange(startTrusted, nextTrusted) {
  await __testing.resetState();
  const factory = createIdleQueryFactory();
  __testing.setQueryFn(factory.queryFn);
  const params = { ...base, sessionId: 'sess-trust' };
  try {
    await __testing.acquireRuntime(await __testing.buildRequestContext({ ...params, projectTrusted: startTrusted }));
    await getContextUsagePersistent({ ...params, projectTrusted: nextTrusted });
    return factory.runtimes.map((runtime) => runtime.options.settingSources);
  } finally {
    await __testing.resetState();
    process.chdir(originalCwd);
  }
}

test('/context rebuilds a trusted runtime once the project is no longer trusted', async () => {
  assert.deepEqual(await contextUsageAfterTrustChange(true, false), [['user', 'project', 'local'], ['user']]);
});

test('/context rebuilds an untrusted runtime once the project is trusted', async () => {
  assert.deepEqual(await contextUsageAfterTrustChange(false, true), [['user'], ['user', 'project', 'local']]);
});

test('/context keeps reusing a runtime whose trust has not changed', async () => {
  assert.deepEqual(await contextUsageAfterTrustChange(true, true), [['user', 'project', 'local']]);
  assert.deepEqual(await contextUsageAfterTrustChange(false, false), [['user']]);
});
