import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createEventContext,
  handleOpenCodeEvent
} from './message-service.js';

const FIXTURE_URL = new URL('../../../test-fixtures/opencode/role-gated-tool-boundary.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
}

async function captureBridgeOutput(fn) {
  const originalLog = console.log;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines = [];

  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) lines.push(line);
    }
    return true;
  };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return lines;
}

function markerPayloads(lines, marker) {
  const prefix = `${marker} `;
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)));
}

function messagePayloads(lines) {
  return markerPayloads(lines, '[MESSAGE]');
}

function toolUseIds(messages) {
  return messages.flatMap((message) => {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((block) => block?.type === 'tool_use')
      .map((block) => block.id);
  });
}

function toolResultIds(messages) {
  return messages.flatMap((message) => {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((block) => block?.type === 'tool_result')
      .map((block) => block.tool_use_id);
  });
}

test('opencode replay fixture preserves role-gated tool boundary rendering', async () => {
  const fixture = await loadFixture();
  const ctx = createEventContext(null, fixture.cwd, 'default', { id: fixture.sessionId });

  const lines = await captureBridgeOutput(async () => {
    for (const event of fixture.events) {
      await handleOpenCodeEvent(event, ctx);
    }
  });

  assert.deepEqual(markerPayloads(lines, '[CONTENT_DELTA]'), fixture.expect.contentDeltas);
  assert.deepEqual(markerPayloads(lines, '[THINKING_DELTA]'), fixture.expect.thinkingDeltas);

  const allOutput = lines.join('\n');
  for (const forbidden of fixture.expect.forbiddenContent) {
    assert.equal(allOutput.includes(forbidden), false, `${forbidden} should not render`);
  }

  const messages = messagePayloads(lines);
  assert.deepEqual(toolUseIds(messages), fixture.expect.toolUseIds);
  assert.deepEqual(toolResultIds(messages), fixture.expect.toolResultIds);
  assert.equal(lines.filter((line) => line === '[BLOCK_RESET]').length, fixture.expect.blockResetCount);

  const contentPositions = fixture.expect.contentDeltas.map((delta) =>
    lines.findIndex((line) => line === `[CONTENT_DELTA] ${JSON.stringify(delta)}`)
  );
  const blockResetIndex = lines.findIndex((line) => line === '[BLOCK_RESET]');
  assert.ok(contentPositions[0] >= 0, 'first content delta should be emitted');
  assert.ok(blockResetIndex > contentPositions[0], 'tool block reset should follow first text');
  assert.ok(contentPositions[1] > blockResetIndex, 'post-tool text should follow block reset');
});
