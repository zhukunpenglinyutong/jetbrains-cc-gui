import './testing/cli-login-home.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './persistent-query-service.js';

const base = { sessionId: '', model: 'claude-sonnet-4-6', cwd: process.cwd(), permissionMode: 'default' };

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
