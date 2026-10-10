import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGrokAgentLaunch } from './grok-utils.js';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const permDir = mkdtempSync(path.join(tmpdir(), 'grok-ask-wire-'));
const capturePath = path.join(permDir, 'capture.json');
process.env.CLAUDE_PERMISSION_DIR = permDir;
process.env.CLAUDE_SESSION_ID = 'wiretest';
process.env.GROK_AUTH_METHOD = 'oauth';
process.env.CAPTURE_PATH = capturePath;

const fakePath = path.join(permDir, 'fake-grok.mjs');
writeFileSync(fakePath, `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  };
  if (msg.id === 9001 && msg.result) {
    fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(msg.result));
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }) + '\\n');
    return;
  }
  if (!msg.method || msg.id == null) return;
  if (msg.method === 'initialize') {
    reply({ protocolVersion: 1, authMethods: [{ id: 'cached_token' }] });
    return;
  }
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    reply({ sessionId: 'sess-wire' });
    return;
  }
  if (msg.method === 'session/prompt') {
    const text = JSON.stringify(msg.params?.prompt || '');
    if (!text.includes('PROBE_ASK_USER_QUESTION')) {
      reply({});
      return;
    }
    promptId = msg.id;
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 9001,
      method: '_x.ai/ask_user_question',
      params: {
        sessionId: 'sess-wire',
        toolCallId: 'tool-1',
        questions: [{
          id: 'wire',
          question: 'Which wire tag?',
          options: [{ label: 'PascalCase', description: '' }],
          multiSelect: false,
        }],
        mode: 'default',
      },
    }) + '\\n');
    return;
  }
  reply({});
});
`);
chmodSync(fakePath, 0o755);
process.env.GROK_CLI_PATH = fakePath;

function answerPendingQuestion() {
  for (const name of readdirSync(permDir)) {
    if (!name.startsWith('ask-user-question-wiretest-') || name.includes('response')) continue;
    const request = JSON.parse(readFileSync(path.join(permDir, name), 'utf8'));
    const question = request.questions?.[0]?.question;
    if (!question) continue;
    const responseName = name.replace('ask-user-question-', 'ask-user-question-response-');
    writeFileSync(path.join(permDir, responseName), JSON.stringify({
      requestId: request.requestId,
      answers: { [question]: 'PascalCase' },
    }));
  }
}

test('windows launches a node-script Grok CLI through node.exe', () => {
  const script = 'C:\\temp\\fake-grok.mjs';
  const launch = resolveGrokAgentLaunch(script, 'win32');
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.args, [script, 'agent', 'stdio']);
  assert.equal(launch.windowsHide, true);

  const exe = resolveGrokAgentLaunch('C:\\grok\\grok.exe', 'win32');
  assert.equal(exe.file, 'C:\\grok\\grok.exe');
  assert.deepEqual(exe.args, ['agent', 'stdio']);
  assert.equal(exe.windowsHide, false);

  const unix = resolveGrokAgentLaunch('/tmp/fake-grok.mjs', 'linux');
  assert.equal(unix.file, '/tmp/fake-grok.mjs');
  assert.deepEqual(unix.args, ['agent', 'stdio']);
});

test('runAcpTurn answers _x.ai/ask_user_question with accepted, not the permission allow', async () => {
  const { runAcpTurn } = await import('./grok-acp-client.js');
  const timer = setInterval(answerPendingQuestion, 20);
  try {
    await runAcpTurn({
      message: 'PROBE_ASK_USER_QUESTION',
      authMethod: 'oauth',
      permissionMode: 'default',
      reasoningEffort: '',
      cwd: permDir,
    });
  } finally {
    clearInterval(timer);
  }
  const result = JSON.parse(readFileSync(capturePath, 'utf8'));
  assert.deepEqual(result, {
    outcome: 'accepted',
    answers: { 'Which wire tag?': 'PascalCase' },
  });
});

test('sendMessagePersistent answers _x.ai/ask_user_question with accepted, not the permission allow', async () => {
  const persistentCapture = path.join(permDir, 'capture-persistent.json');
  process.env.CAPTURE_PATH = persistentCapture;
  const { sendMessagePersistent, shutdownPersistentRuntimes } = await import('./persistent-acp-service.js');
  const timer = setInterval(answerPendingQuestion, 20);
  try {
    await sendMessagePersistent({
      message: 'PROBE_ASK_USER_QUESTION',
      authMethod: 'oauth',
      permissionMode: 'default',
      reasoningEffort: '',
      cwd: permDir,
      runtimeSessionEpoch: 'wire-persistent',
    });
  } finally {
    clearInterval(timer);
    await shutdownPersistentRuntimes();
  }
  const result = JSON.parse(readFileSync(persistentCapture, 'utf8'));
  assert.deepEqual(result, {
    outcome: 'accepted',
    answers: { 'Which wire tag?': 'PascalCase' },
  });
});

after(() => {
  rmSync(permDir, { recursive: true, force: true });
});
