import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEventContext,
  handleOpenCodeEvent,
  normalizeOpenCodeMessage
} from './message-service.js';

async function captureConsole(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

function messagePayloads(lines) {
  return lines
    .filter((line) => line.startsWith('[MESSAGE] '))
    .map((line) => JSON.parse(line.slice('[MESSAGE] '.length)));
}

function toolPart(overrides = {}) {
  return {
    id: 'prt_tool_1',
    sessionID: 'ses_test',
    messageID: 'msg_assistant_1',
    type: 'tool',
    callID: 'call_1',
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'npm test', description: 'Run tests' },
      title: 'Run tests',
      time: { start: 1 }
    },
    ...overrides
  };
}

test('opencode tool updates emit tool_use and tool_result blocks', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: { part: toolPart() }
    }, ctx);
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: toolPart({
          state: {
            status: 'completed',
            input: { command: 'npm test', description: 'Run tests' },
            output: 'ok',
            title: 'Run tests',
            metadata: {},
            time: { start: 1, end: 2 }
          }
        })
      }
    }, ctx);
  });

  const messages = messagePayloads(lines);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0].message.content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'bash',
    input: { command: 'npm test', description: 'Run tests' }
  });
  assert.deepEqual(messages[2].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    is_error: false,
    content: 'ok'
  });
});

test('opencode edit metadata is normalized for existing diff UI', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: toolPart({
          tool: 'edit',
          state: {
            status: 'completed',
            input: { filePath: '/repo/src/app.ts' },
            output: '',
            title: 'edit',
            metadata: {
              filediff: {
                file: '/repo/src/app.ts',
                before: 'const value = 1',
                after: 'const value = 2',
                additions: 1,
                deletions: 1
              }
            },
            time: { start: 1, end: 2 }
          }
        })
      }
    }, ctx);
  });

  const [toolUse] = messagePayloads(lines);
  assert.equal(toolUse.message.content[0].type, 'tool_use');
  assert.equal(toolUse.message.content[0].name, 'edit');
  assert.deepEqual(toolUse.message.content[0].input, {
    filePath: '/repo/src/app.ts',
    file_path: '/repo/src/app.ts',
    old_string: 'const value = 1',
    new_string: 'const value = 2'
  });
});

test('opencode session.diff emits synthetic edit tool messages', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'session.diff',
      properties: {
        sessionID: 'ses_test',
        diff: [{
          file: '/repo/src/app.ts',
          patch: '@@ -1 +1 @@\n-const value = 1\n+const value = 2\n',
          additions: 1,
          deletions: 1
        }]
      }
    }, ctx);
  });

  const messages = messagePayloads(lines);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.content[0].type, 'tool_use');
  assert.equal(messages[0].message.content[0].name, 'edit');
  assert.equal(messages[0].message.content[0].input.file_path, '/repo/src/app.ts');
  assert.equal(messages[0].message.content[0].input.old_string, 'const value = 1');
  assert.equal(messages[0].message.content[0].input.new_string, 'const value = 2');
  assert.equal(messages[1].message.content[0].type, 'tool_result');
});

test('opencode history normalization preserves completed tool parts', () => {
  const normalized = normalizeOpenCodeMessage({
    info: { id: 'msg_assistant_1', role: 'assistant' },
    parts: [
      toolPart({
        state: {
          status: 'completed',
          input: { filePath: '/repo/src/app.ts', content: 'export const value = 1' },
          output: '',
          title: 'write',
          metadata: {},
          time: { start: 1, end: 2 }
        },
        tool: 'write'
      })
    ]
  });

  assert.deepEqual(normalized.message.content, [
    {
      type: 'tool_use',
      id: 'call_1',
      name: 'write_file',
      input: {
        filePath: '/repo/src/app.ts',
        content: 'export const value = 1',
        file_path: '/repo/src/app.ts',
        new_string: 'export const value = 1'
      }
    },
    {
      type: 'tool_result',
      tool_use_id: 'call_1',
      is_error: false,
      content: 'write'
    }
  ]);
});
