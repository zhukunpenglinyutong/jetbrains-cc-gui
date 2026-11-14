import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { buildSessionCodexConfig } from '../../config/session-supplier.js';
import { buildCodexNativeRuntime } from './codex-native-runtime-config.js';
import { CodexAppServerClient } from './codex-appserver-client.js';
import { CodexAppServerService } from './codex-appserver-service.js';

const command = process.env.CODEX_CLI_TEST_COMMAND ? JSON.parse(process.env.CODEX_CLI_TEST_COMMAND) : null;
const required = process.env.CODEX_CLI_REQUIRE_REAL === '1';

test('native supplier processes send, cold-resume and switch suppliers without global configuration changes', {
  skip: !command && !required ? 'Set CODEX_CLI_TEST_COMMAND to run the isolated native supplier test' : false,
  timeout: 90_000,
}, async t => {
  assert.ok(Array.isArray(command) && command.length > 0, 'CODEX_CLI_TEST_COMMAND must identify the installed CLI');
  const root = mkdtempSync(join(tmpdir(), 'ccgui-native-suppliers-'));
  const home = join(root, 'shared history');
  const cwd = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(cwd);
  const requests = [];
  const services = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"models":[]}');
        return;
      }
      requests.push({ path: request.url, authorization: request.headers.authorization,
        header: request.headers['x-fixture-supplier'], body: JSON.parse(body) });
      const item = { type: 'message', id: 'msg_' + randomUUID(), role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Bound supplier fixture finished.', annotations: [] }] };
      const id = 'resp_' + randomUUID();
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const event of [
        { type: 'response.created', response: { id, status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  t.after(async () => {
    await Promise.all(services.map(service => service.resetRuntime({ reason: 'supplier-fixture-finished' })));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const cleanupRoot = realpathSync(root);
    assert.equal(dirname(cleanupRoot), realpathSync(tmpdir()));
    assert.ok(basename(cleanupRoot).startsWith('ccgui-native-suppliers-'));
    await rm(cleanupRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const nativeConfig = `model="gpt-6.1-sol"\nmodel_provider="OpenAI"\n[model_providers.OpenAI]\n`
    + `name="OpenAI"\nbase_url="${endpoint}/global/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`
    + `env_key="LEGACY_FIXTURE_KEY"\n`;
  const nativeAuth = '{"OPENAI_API_KEY":"fixture-global-key"}';
  writeFileSync(join(home, 'config.toml'), nativeConfig);
  writeFileSync(join(home, 'auth.json'), nativeAuth);
  const config = { codex: { providers: Object.fromEntries(['a', 'b'].map(id => [id, {
    configToml: `model_provider="${id}"\n[model_providers.${id}]\nname="Fixture ${id}"\n`
      + `base_url="${endpoint}/${id}/v1"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`
      + `[model_providers.${id}.http_headers]\nX-Fixture-Supplier="fixture-header-${id}"\n`,
    authJson: JSON.stringify({ OPENAI_API_KEY: `fixture-key-${id}` }),
  }])) } };
  const baseEnv = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: home };
  for (const key of Object.keys(baseEnv)) if (/API_KEY|TOKEN|SECRET|AUTHORIZATION|NODE_OPTIONS/i.test(key)) delete baseEnv[key];
  baseEnv.LEGACY_FIXTURE_KEY = 'fixture-global-key';
  const beforeEnv = { ...process.env };
  const createService = supplierId => {
    const supplier = buildSessionCodexConfig(supplierId, { config, baseEnv });
    const runtime = buildCodexNativeRuntime({ ...(supplier ?? { authMode: 'cli_login' }), baseEnv });
    const service = new CodexAppServerService({ launchOptions: {
      cwd, nativeConfig: runtime.config, modelProvider: runtime.modelProvider,
    }, clientFactory: async ({ nativeConfig = runtime.config, modelProvider = runtime.modelProvider } = {}) => {
      const client = new CodexAppServerClient({ command, cwd, env: runtime.env, nativeConfig, modelProvider });
      try {
        await client.ensureInitialized();
        const actual = await client.request('config/read', { includeLayers: true, cwd });
        const userLayer = actual.layers?.find(layer => layer.name?.type === 'user');
        // On Windows, HOME/USERPROFILE alone may not isolate the native profile.
        // Verify the native home and loopback route before starting any thread.
        assert.ok(userLayer?.name?.file, 'The native CLI must report its fixture configuration layer');
        // Native realpath also expands Windows 8.3 aliases used by hosted runners.
        assert.equal(realpathSync.native(userLayer.name.file), realpathSync.native(join(home, 'config.toml')),
          'The native CLI must use the isolated fixture home');
        assert.equal(actual.config?.model_providers?.[modelProvider ?? 'OpenAI']?.base_url,
          `${endpoint}/${supplierId ?? 'global'}/v1`, 'Model requests must stay on the fixture server');
        return client;
      } catch (error) {
        client.close();
        await client.waitForExit();
        throw error;
      }
    } });
    services.push(service);
    return service;
  };
  const send = service => service.send({ input: [{ type: 'text', text: 'Return the fixture message without tools.' }],
    settings: { cwd, model: 'gpt-6.1-sol', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false } });
  const a = createService('a');
  const b = createService('b');
  await a.ensureRuntime();
  await b.ensureRuntime();
  for (const result of await Promise.all([send(a), send(b)])) assert.equal(result.outcome, 'completed', result.error);
  assert.equal((await send(a)).outcome, 'completed');
  const threadId = a.rootThreadId;
  await a.resetRuntime();
  const restored = createService('a');
  await restored.preconnect({ threadId });
  assert.equal((await send(restored)).outcome, 'completed');
  assert.equal(restored.rootThreadId, threadId);
  await restored.resetRuntime();
  const switched = createService('b');
  await switched.preconnect({ threadId });
  assert.equal((await send(switched)).outcome, 'completed');
  assert.equal(switched.rootThreadId, threadId);
  assert.equal(requests.length, 5, 'Bootstrap and resume never send extra model requests');
  assert.equal(requests.filter(request => request.path === '/a/v1/responses').length, 3);
  assert.equal(requests.filter(request => request.path === '/b/v1/responses').length, 2);
  for (const request of requests) {
    const id = request.path.split('/')[1];
    assert.equal(request.authorization, `Bearer fixture-key-${id}`);
    assert.equal(request.header, `fixture-header-${id}`);
  }
  const legacy = createService(null);
  assert.equal((await send(legacy)).outcome, 'completed');
  assert.equal(requests.length, 6);
  assert.equal(requests.at(-1).path, '/global/v1/responses');
  assert.equal(requests.at(-1).authorization, 'Bearer fixture-global-key');
  const legacyThreadId = legacy.rootThreadId;
  await legacy.resetRuntime();
  const migrated = createService('a');
  await migrated.preconnect({ threadId: legacyThreadId });
  const migrationResult = await send(migrated);
  assert.equal(migrationResult.outcome, 'completed', migrationResult.error);
  assert.equal(migrated.rootThreadId, legacyThreadId);
  assert.equal(requests.at(-1).path, '/a/v1/responses');
  assert.equal(requests.at(-1).authorization, 'Bearer fixture-key-a');
  assert.match(JSON.stringify(requests.at(-1).body.input), /Bound supplier fixture finished/);
  // Older CLIs accept the bound provider directly; newer ones may retain the historical id.
  // Both must route that id through the selected supplier's isolated configuration.
  const migratedProvider = migrated.launchOptions.nativeConfig?.model_providers?.[migrated.launchOptions.modelProvider];
  assert.equal(migratedProvider?.base_url, `${endpoint}/a/v1`);
  assert.equal(migratedProvider?.env_key, 'CODEX_API_KEY');
  await migrated.resetRuntime();
  await migrated.preconnect({ threadId: legacyThreadId });
  assert.equal((await send(migrated)).outcome, 'completed');
  assert.equal(migrated.rootThreadId, legacyThreadId);
  await migrated.resetRuntime();
  const legacySwitched = createService('b');
  await legacySwitched.preconnect({ threadId: legacyThreadId });
  assert.equal((await send(legacySwitched)).outcome, 'completed');
  assert.equal(legacySwitched.rootThreadId, legacyThreadId);
  assert.equal(requests.at(-1).path, '/b/v1/responses');
  assert.equal(requests.at(-1).authorization, 'Bearer fixture-key-b');
  assert.equal(requests.at(-1).header, 'fixture-header-b');
  assert.equal(requests.length, 9, 'Recovery never repeats model requests');
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), nativeConfig);
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), nativeAuth);
  assert.deepEqual({ ...process.env }, beforeEnv);
});
