import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAppServerClient } from '../ai-bridge/services/codex/codex-appserver-client.js';

const cli = process.env.CC_GUI_HOOKS_TEST_CLI;

// This only lists local hooks. It does not log in, execute hooks, or call a model.
test('Codex 0.163.0 reads per-handler user state for TOML and JSON hooks', {
  skip: !cli && 'Set CC_GUI_HOOKS_TEST_CLI to the pinned 0.163.0 CLI entry point',
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ccgui-hooks-contract-'));
  const codexHome = path.join(home, '.codex');
  const cwd = path.join(home, 'project');
  await mkdir(codexHome);
  await mkdir(cwd);
  const configPath = path.join(codexHome, 'config.toml');
  const hooksPath = path.join(codexHome, 'hooks.json');
  const original = 'cli_auth_credentials_store="file"\n'
    + '[[hooks.PreToolUse]]\nmatcher="Bash"\n'
    + 'hooks=[{type="command",command="echo first-fixture"},'
    + '{type="command",command="echo second-fixture"}]\n';
  const declaration = JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: 'command', command: 'echo json-fixture' },
  ] }] } });
  await writeFile(configPath, original);
  await writeFile(hooksPath, declaration);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/API_KEY|TOKEN|SECRET|AUTHORIZATION|NODE_OPTIONS/.test(key.toUpperCase())));
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome });
  const command = /\.m?js$/i.test(cli) ? [process.execPath, cli] : [cli];
  async function list() {
    const client = new CodexAppServerClient({ command, env, cwd,
      requestTimeoutMs: 15_000, contextSupportProbe: async () => false });
    try {
      const response = await client.request('hooks/list', { cwds: [cwd] });
      assert.equal(response.data.length, 1);
      assert.deepEqual(response.data[0].errors, []);
      return response.data[0].hooks;
    } finally {
      client.close();
      await client.waitForExit();
    }
  }
  try {
    const firstKey = `${configPath}:pre_tool_use:0:0`;
    const secondKey = `${configPath}:pre_tool_use:0:1`;
    const jsonKey = `${hooksPath}:stop:0:0`;
    let items = await list();
    assert.deepEqual(new Set(items.map(item => item.key)), new Set([firstKey, secondKey, jsonKey]));
    assert.ok(items.every(item => item.enabled === true));
    assert.ok(items.every(item => item.trustStatus === 'untrusted'));
    const state = enabled => `\n[hooks.state.${JSON.stringify(firstKey)}]\nenabled=${enabled}\n`
      + `[hooks.state.${JSON.stringify(jsonKey)}]\nenabled=${enabled}\n`;
    await writeFile(configPath, original + state(false));
    items = await list();
    assert.equal(items.find(item => item.key === firstKey).enabled, false);
    assert.equal(items.find(item => item.key === jsonKey).enabled, false);
    assert.equal(items.find(item => item.key === secondKey).enabled, true);
    await writeFile(configPath, original + state(true));
    items = await list();
    assert.ok(items.every(item => item.enabled === true));
    assert.equal(await readFile(hooksPath, 'utf8'), declaration);
    const alias = path.join(home, 'codex-alias');
    await symlink(codexHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
    env.CODEX_HOME = alias;
    items = await list();
    assert.deepEqual(new Set(items.map(item => item.key)), new Set([firstKey, secondKey, jsonKey]));
    assert.ok(items.every(item => item.enabled === true));

  } finally {
    const resolved = path.resolve(home);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('ccgui-hooks-contract-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
