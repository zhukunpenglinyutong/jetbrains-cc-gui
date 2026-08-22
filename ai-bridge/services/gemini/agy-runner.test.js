import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgyTurn } from './agy-runner.js';

function makeFakeAgy(scriptBody) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fake-'));
  const bin = join(dir, 'agy-fake');
  writeFileSync(bin, scriptBody, { encoding: 'utf8' });
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test('runAgyTurn parses NDJSON stream and returns SUCCESS', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
const events = [
  { event: 'init', conversation_id: 'conv-1' },
  { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hi', state: 'DONE' } },
  { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'hi', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];
for (const e of events) console.log(JSON.stringify(e));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const events = [];
    const turn = await runAgyTurn({
      message: 'hello',
      onEvent: (e) => events.push(e),
    });
    assert.equal(turn.conversationId, 'conv-1');
    assert.equal(turn.status, 'SUCCESS');
    assert.equal(turn.response, 'hi');
    assert.equal(turn.exitCode, 0);
    assert.ok(events.some((e) => e.event === 'init'));
    assert.ok(events.some((e) => e.event === 'result'));
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn rejects when binary missing', async () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  const prevPath = process.env.PATH;
  process.env.AGY_PATH = '/nonexistent/agy-binary-xyz';
  process.env.GEMINI_CLI_PATH = '';
  process.env.AGY_CLI_PATH = '';
  process.env.PATH = '';
  try {
    await assert.rejects(
      () => runAgyTurn({ message: 'x' }),
      /not found/i,
    );
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
    process.env.PATH = prevPath;
  }
});

test('runAgyTurn rejects hard failure with no partial output', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
console.error('authentication required');
process.exit(2);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    await assert.rejects(
      () => runAgyTurn({ message: 'x' }),
      /authentication required|exited with code/i,
    );
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn never passes --effort (effort is in model slug only)', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'ok' } }));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  const logPath = join(dir, 'argv.json');
  process.env.AGY_PATH = bin;
  process.env.AGY_ARGV_LOG = logPath;
  try {
    await runAgyTurn({
      message: 'hi',
      model: 'claude-sonnet-4-6',
      reasoningEffort: '',
    });
    const { readFileSync } = await import('node:fs');
    const argv = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.ok(argv.includes('--model'));
    assert.ok(argv.includes('claude-sonnet-4-6'));
    assert.ok(!argv.includes('--effort'), 'must not pass --effort, got: ' + argv.join(' '));
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    delete process.env.AGY_ARGV_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn upgrades bare gemini family to full effort slug', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'ok' } }));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  const logPath = join(dir, 'argv-flash.json');
  process.env.AGY_PATH = bin;
  process.env.AGY_ARGV_LOG = logPath;
  try {
    await runAgyTurn({
      message: 'hi',
      model: 'gemini-3.6-flash',
      reasoningEffort: '',
    });
    const { readFileSync } = await import('node:fs');
    const argv = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.ok(argv.includes('--model'));
    assert.ok(argv.includes('gemini-3.6-flash-medium'), 'got: ' + argv.join(' '));
    assert.ok(!argv.includes('--effort'), 'must not pass --effort, got: ' + argv.join(' '));
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    delete process.env.AGY_ARGV_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn surfaces ERROR status payload despite exit code 0', async () => {
  // agy ≥ 1.1.11: interactive-only slash commands (e.g. /clear) exit 0 but
  // carry status:"ERROR" + actionable error text in the result payload.
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: '',
    status: 'ERROR',
    response: '',
    error: '/clear is not available in print mode (every print-mode run already starts a new conversation unless --continue or --conversation is passed); pass --disable-slash-commands to send /clear to the model as literal text',
  },
}));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const turn = await runAgyTurn({ message: '/clear' });
    assert.equal(turn.exitCode, 0);
    assert.equal(turn.status, 'ERROR');
    assert.match(turn.error, /not available in print mode/);
    // callers (message-service) throw on non-SUCCESS without response text
    assert.equal(turn.response, '');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

