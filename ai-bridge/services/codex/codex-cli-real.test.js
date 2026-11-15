import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CodexAppServerClient } from './codex-appserver-client.js';
import { readNativeHistoryPage } from './codex-native-history.js';
import { buildTurnSettings } from './persistent-codex-service.js';

const command = process.env.CODEX_CLI_TEST_COMMAND ? JSON.parse(process.env.CODEX_CLI_TEST_COMMAND) : null;
const required = process.env.CODEX_CLI_REQUIRE_REAL === '1';

test('official CLI supports isolated native catalogs, effective permissions and history', {
  skip: !command && !required ? 'Set CODEX_CLI_TEST_COMMAND to an official CLI argv array' : false,
  timeout: 90_000,
}, async t => {
  assert.ok(Array.isArray(command) && command.length > 0 && command.every(value => typeof value === 'string'),
    'CODEX_CLI_TEST_COMMAND must identify the official installed CLI');
  const root = mkdtempSync(join(tmpdir(), 'codex-real-cli-'));
  const home = join(root, 'native home with spaces');
  const cwd = join(root, 'workspace with spaces');
  const skill = join(cwd, '.agents/skills/ccgui-fixture');
  mkdirSync(home);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: ccgui-fixture\ndescription: Native catalog acceptance fixture\n---\nReturn a fixture value.\n');
  const mcp = join(root, 'mcp fixture.cjs');
  writeFileSync(mcp, `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.id == null) return;
      let result = {};
      if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'ccgui-fixture', version: '1.0.0' } };
      if (request.method === 'tools/list') result = { tools: [{ name: 'fixture_echo', description: 'Read-only fixture',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  writeFileSync(join(home, 'config.toml'), '[mcp_servers.ccgui_fixture]\ncommand = '
    + JSON.stringify(process.execPath.replaceAll('\\', '/')) + '\nargs = ['
    + JSON.stringify(mcp.replaceAll('\\', '/')) + ']\nstartup_timeout_sec = 20\n');
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: home };
  for (const key of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|AUTHORIZATION|NODE_OPTIONS/i.test(key)) delete env[key];
  }
  const client = new CodexAppServerClient({ command, cwd, env });
  t.after(async () => {
    client.close();
    await client.waitForExit();
    const cleanupRoot = realpathSync(root);
    assert.equal(dirname(cleanupRoot), realpathSync(tmpdir()));
    assert.ok(basename(cleanupRoot).startsWith('codex-real-cli-'));
    await rm(cleanupRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await client.start();

  await t.test('native model, skill and MCP discovery needs no SDK or user account', async () => {
    const models = await client.request('model/list', {});
    assert.ok(Array.isArray(models.data));
    const skills = await client.request('skills/list', { cwds: [cwd], forceReload: true });
    assert.ok(skills.data.some(entry => entry.skills?.some(value => value.name === 'ccgui-fixture')));
    let server;
    const deadline = Date.now() + 20_000;
    do {
      const catalog = await client.request('mcpServerStatus/list', {});
      server = catalog.data.find(value => value.name === 'ccgui_fixture');
      if (Object.keys(server?.tools ?? {}).length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.ok(Object.keys(server?.tools ?? {}).some(name => name.endsWith('fixture_echo')));
  });

  await t.test('migrated Full Auto and explicit access scopes reach native effective settings', async () => {
    for (const [input, type, approvalPolicy] of [
      [{ permissionMode: 'readOnly' }, 'readOnly', 'on-request'],
      [{ permissionMode: 'bypassPermissions' }, 'dangerFullAccess', 'never'],
      [{ permissionMode: 'bypassPermissions', sandboxSource: 'default',
        rawSandboxConfig: { sandboxMode: 'read-only', sandboxSource: 'default' } }, 'dangerFullAccess', 'never'],
      [{ permissionMode: 'bypassPermissions', sandboxSource: 'user', sandboxSelection: 'read-only',
        approvalPreset: 'request' }, 'readOnly', 'on-request'],
      // Native Windows falls back to read-only before its sandbox is configured.
      // The bridge must still send the user's workspace scope without broadening it.
      [{ permissionMode: 'bypassPermissions', sandboxSource: 'native', sandboxSelection: 'workspace-write',
        approvalPreset: 'request' }, process.platform === 'win32' ? 'readOnly' : 'workspaceWrite', 'on-request'],
    ]) {
      const settings = buildTurnSettings(input);
      if (input.sandboxSelection) assert.equal(settings.sandbox, input.sandboxSelection);
      const response = await client.request('thread/start', { cwd, sandbox: settings.sandbox,
        approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, ephemeral: true });
      assert.equal(response.sandbox.type, type);
      assert.equal(response.approvalPolicy, approvalPolicy);
    }
  });

  await t.test('persisted native history is readable through the shared projection', async () => {
    const { thread } = await client.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: false });
    const history = await readNativeHistoryPage((method, params) => client.request(method, params), { threadId: thread.id });
    assert.equal(history.thread.id, thread.id);
    assert.equal(history.complete, true);
    assert.deepEqual(history.messages, []);
  });
});
