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

test('opencode task tool input and subagent metadata are preserved', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: toolPart({
          tool: 'task',
          state: {
            status: 'running',
            input: {
              prompt: 'Inspect renderer task details',
              description: 'Inspect renderer',
              subagent_type: 'explore'
            },
            title: 'Inspect renderer',
            metadata: {
              sessionId: 'ses_child'
            },
            time: { start: 1 }
          }
        })
      }
    }, ctx);
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: toolPart({
          tool: 'task',
          state: {
            status: 'completed',
            input: {
              prompt: 'Inspect renderer task details',
              description: 'Inspect renderer',
              subagent_type: 'explore'
            },
            output: 'task_id: ses_child\n\n<task_result>\nDone\n</task_result>',
            title: 'Inspect renderer',
            metadata: {
              sessionId: 'ses_child',
              toolCalls: 3
            },
            time: { start: 1, end: 2 }
          }
        })
      }
    }, ctx);
  });

  const messages = messagePayloads(lines);
  const toolUse = messages.find((message) => message.type === 'assistant');
  const toolResult = messages.find((message) => message.type === 'user');
  assert.deepEqual(toolUse.message.content[0].input, {
    prompt: 'Inspect renderer task details',
    description: 'Inspect renderer',
    subagent_type: 'explore',
    subagent_session_id: 'ses_child',
    agentId: 'ses_child'
  });
  assert.deepEqual(toolResult.toolUseResult, {
    agentId: 'ses_child',
    subagentSessionId: 'ses_child',
    agentType: 'explore',
    description: 'Inspect renderer',
    totalToolUseCount: 3
  });
});

test('opencode task raw pending input is normalized', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: toolPart({
          tool: 'task',
          state: {
            status: 'pending',
            input: {},
            raw: JSON.stringify({
              prompt: 'Inspect renderer task details',
              description: 'Inspect renderer',
              subagent_type: 'explore'
            })
          }
        })
      }
    }, ctx);
  });

  const [toolUse] = messagePayloads(lines).filter((message) => message.type === 'assistant');
  assert.deepEqual(toolUse.message.content[0].input, {
    prompt: 'Inspect renderer task details',
    description: 'Inspect renderer',
    subagent_type: 'explore'
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

  const toolMessages = messagePayloads(lines).filter((message) => message.type !== 'status');
  const [toolUse] = toolMessages;
  assert.equal(toolMessages.length, 2);
  assert.equal(toolUse.message.content[0].type, 'tool_use');
  assert.equal(toolUse.message.content[0].name, 'edit');
  assert.deepEqual(toolUse.message.content[0].input, {
    filePath: '/repo/src/app.ts',
    file_path: '/repo/src/app.ts',
    workdir: '/repo',
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
  assert.equal(messages[0].message.content[0].input.workdir, '/repo');
  assert.equal(messages[0].message.content[0].input.old_string, 'const value = 1');
  assert.equal(messages[0].message.content[0].input.new_string, 'const value = 2');
  assert.equal(messages[1].message.content[0].type, 'tool_result');
});

test('opencode session.diff deduplicates equivalent relative and absolute paths', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'session.diff',
      properties: {
        sessionID: 'ses_test',
        diff: [{
          file: 'src/app.ts',
          patch: '@@ -1 +1 @@\n-const value = 1\n+const value = 2\n'
        }]
      }
    }, ctx);
    await handleOpenCodeEvent({
      type: 'session.diff',
      properties: {
        sessionID: 'ses_test',
        diff: [{
          file: '/repo/src/app.ts',
          patch: '@@ -1 +1 @@\n-const value = 1\n+const value = 2\n'
        }]
      }
    }, ctx);
  });

  const messages = messagePayloads(lines);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.content[0].input.file_path, '/repo/src/app.ts');
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

test('opencode history normalization restores apply_patch diffs as edit blocks', () => {
  const normalized = normalizeOpenCodeMessage({
    info: {
      id: 'msg_assistant_1',
      role: 'assistant',
      path: { cwd: '/repo', root: '/repo' }
    },
    parts: [
      toolPart({
        callID: 'call_patch_1',
        tool: 'apply_patch',
        state: {
          status: 'completed',
          input: {
            patchText: [
              '*** Begin Patch',
              '*** Update File: src/app.ts',
              '@@',
              '-const value = 1',
              '+const value = 2',
              '*** End Patch'
            ].join('\n')
          },
          output: 'Success. Updated the following files:\nM src/app.ts',
          title: 'apply_patch',
          metadata: {
            files: [{
              filePath: '/repo/src/app.ts',
              relativePath: 'src/app.ts',
              patch: '@@ -1 +1 @@\n-const value = 1\n+const value = 2\n',
              additions: 1,
              deletions: 1
            }]
          },
          time: { start: 1, end: 2 }
        }
      })
    ]
  });

  assert.equal(normalized.message.content.length, 2);
  assert.deepEqual(normalized.message.content[0], {
    type: 'tool_use',
    id: normalized.message.content[0].id,
    name: 'edit',
    input: {
      file_path: '/repo/src/app.ts',
      old_string: 'const value = 1',
      new_string: 'const value = 2',
      patch: '@@ -1 +1 @@\n-const value = 1\n+const value = 2\n',
      workdir: '/repo',
      source: 'tool:call_patch_1',
      status: undefined,
      additions: 1,
      deletions: 1
    }
  });
  assert.equal(normalized.message.content[1].type, 'tool_result');
  assert.equal(normalized.message.content[1].tool_use_id, normalized.message.content[0].id);
});
