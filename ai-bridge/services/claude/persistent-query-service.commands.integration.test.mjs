import { testHomeDir } from './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { __testing } from './persistent-query-service.js';

const sdkPath = process.env.CLAUDE_COMMAND_TEST_SDK_PATH;

// Use a selected SDK with isolated settings and a loopback API. No developer
// credentials, real model calls, or changes to the developer's sessions are needed.
test('Claude dispatches compact and custom commands with per-turn IDE context', {
  skip: !sdkPath && 'Set CLAUDE_COMMAND_TEST_SDK_PATH to an installed sdk.mjs',
  timeout: 60000,
}, async t => {
  const { query } = await import(pathToFileURL(sdkPath).href);
  const requests = [];
  const events = [];
  let launches = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    res.setHeader('Content-Type', 'application/json');
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    const payload = JSON.parse(raw);
    requests.push(payload);
    const message = {
      id: `msg_command_${requests.length}`, type: 'message', role: 'assistant', model: payload.model,
      content: [{ type: 'text', text: 'Fixture conversation summary.' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (!payload.stream) {
      res.end(JSON.stringify(message));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    for (const event of [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const originalCwd = process.cwd();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 50000);
  t.after(async () => {
    clearTimeout(timeout);
    await __testing.resetState();
    process.chdir(originalCwd);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    TEMP: testHomeDir, TMP: testHomeDir, HOME: testHomeDir, USERPROFILE: testHomeDir,
    CLAUDE_CONFIG_DIR: path.join(testHomeDir, '.claude'),
    ANTHROPIC_API_KEY: 'local-command-test-key', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', USER_TYPE: 'external',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  };
  const commandsDirectory = path.join(testHomeDir, '.claude', 'commands');
  await mkdir(commandsDirectory, { recursive: true });
  await writeFile(path.join(commandsDirectory, 'fixture-command.md'),
    '---\ndescription: Command dispatch fixture\n---\nEXPANDED_COMMAND_FIXTURE: $ARGUMENTS\n');
  __testing.setQueryFn(args => {
    launches++;
    const sdkQuery = query({ ...args, options: {
      ...args.options, env, settingSources: ['user'], persistSession: false, enableFileCheckpointing: false,
      pathToClaudeCodeExecutable: undefined, tools: [], mcpServers: {}, maxTurns: 2, abortController,
    } });
    const next = sdkQuery.next.bind(sdkQuery);
    sdkQuery.next = async () => {
      const result = await next();
      if (!result.done) events.push(result.value);
      return result;
    };
    return sdkQuery;
  });
  let sessionId;
  async function send(message) {
    const context = await __testing.buildRequestContext({
      cwd: testHomeDir, sessionId, runtimeSessionEpoch: 'command-fixture',
      model: 'claude-sonnet-4-6', disableThinking: true, message,
      openedFiles: { active: '/fixture/editor.js', selection: { selectedText: 'const editor = true;' } },
    }, false, { settings: { env } });
    const runtime = await __testing.acquireRuntime(context);
    await __testing.executeTurn(runtime, context);
    sessionId = runtime.sessionId;
  }

  // Older CLIs refuse to compact a single exchange ("Not enough messages to compact").
  await send('Remember the API decisions for this fixture.');
  await send('Also remember the pending work.');
  const customInstructions = 'Keep the API decisions and pending work.';
  await send(`/compact ${customInstructions}`);
  assert.ok(events.some(event => event.type === 'system' && event.subtype === 'compact_boundary'),
    'the native CLI must compact instead of answering the literal slash command');
  assert.ok(requests.some(request => JSON.stringify(request.messages).includes(customInstructions)));

  const beforeCustom = requests.length;
  await send('/fixture-command command-argument');
  const expandedRequest = JSON.stringify(requests.slice(beforeCustom));
  assert.match(expandedRequest, /EXPANDED_COMMAND_FIXTURE: command-argument/);
  assert.match(expandedRequest, /editor\.js/);

  await send('/compact');
  assert.equal(events.filter(event => event.type === 'system' && event.subtype === 'compact_boundary').length, 2);
  assert.equal(launches, 1, 'commands must run on the existing conversation');
});
