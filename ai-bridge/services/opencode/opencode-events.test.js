import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEventContext,
  handleOpenCodeEvent,
  normalizeOpenCodeMessage,
  seedOpenCodeDiffSignatures,
  shouldHandleSessionEvent,
  waitForOpenCodeTurnIdle
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

function contentDeltas(lines) {
  return lines
    .filter((line) => line.startsWith('[CONTENT_DELTA] '))
    .map((line) => JSON.parse(line.slice('[CONTENT_DELTA] '.length)));
}

function sendErrors(lines) {
  return lines
    .filter((line) => line.startsWith('[SEND_ERROR] '))
    .map((line) => JSON.parse(line.slice('[SEND_ERROR] '.length)));
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

function messageUpdated(messageID, role = 'assistant') {
  return {
    type: 'message.updated',
    properties: {
      sessionID: 'ses_test',
      info: { id: messageID, role }
    }
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

test('opencode step-finish emits normalized usage result once', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  ctx.modelContextLimit = 1000;
  const stepFinish = {
    id: 'prt_step_finish_1',
    sessionID: 'ses_test',
    messageID: 'msg_assistant_1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0.0123,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 10, write: 15 }
    }
  };

  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: { part: stepFinish }
    }, ctx);
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: { part: stepFinish }
    }, ctx);
  });

  const results = messagePayloads(lines).filter((message) => message.type === 'result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].usage, {
    input_tokens: 100,
    output_tokens: 25,
    cache_creation_input_tokens: 15,
    cache_read_input_tokens: 10,
    total_tokens: 150,
    context_window: 1000,
    max_tokens: 1000
  });
});

test('opencode shell tools with nonzero exit emit error tool results', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        part: toolPart({
          state: {
            status: 'completed',
            input: { command: 'git diff --no-stat', description: 'Check diff' },
            output: 'fatal: unrecognized argument: --no-stat',
            title: 'Check diff',
            metadata: { exit: 129 },
            time: { start: 1, end: 2 }
          }
        })
      }
    }, ctx);
  });

  const messages = messagePayloads(lines);
  const toolResult = messages.find((message) => message.type === 'user');
  const status = messages.find((message) => message.type === 'status');
  assert.equal(toolResult.message.content[0].is_error, true);
  assert.equal(toolResult.message.content[0].content, 'fatal: unrecognized argument: --no-stat');
  assert.equal(status.message, 'opencode tool: bash (error)');
  assert.match(ctx.lastToolError, /exit 129/);
});

test('opencode final text part fills missing streaming deltas', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_test',
        messageID: 'msg_assistant_1',
        partID: 'prt_text_1',
        field: 'text',
        delta: 'hel'
      }
    }, ctx);
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_test',
        part: {
          id: 'prt_text_1',
          sessionID: 'ses_test',
          messageID: 'msg_assistant_1',
          type: 'text',
          text: 'hello',
          time: { start: 1, end: 2 }
        }
      }
    }, ctx);
    await handleOpenCodeEvent(messageUpdated('msg_assistant_1'), ctx);
  });

  assert.deepEqual(contentDeltas(lines), ['hel', 'lo']);
  assert.equal(ctx.sawAssistantOutput, true);
});

test('opencode inserts space between text parts at part boundaries', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent(messageUpdated('msg_assistant_1'), ctx);

    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_test', messageID: 'msg_assistant_1', partID: 'prt_text_1', field: 'text', delta: 'findings.' }
    }, ctx);
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_test',
        part: { id: 'prt_text_1', sessionID: 'ses_test', messageID: 'msg_assistant_1', type: 'text', text: 'findings.', time: { start: 1, end: 2 } }
      }
    }, ctx);

    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_test', messageID: 'msg_assistant_1', partID: 'prt_text_2', field: 'text', delta: 'The analysis' }
    }, ctx);
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_test',
        part: { id: 'prt_text_2', sessionID: 'ses_test', messageID: 'msg_assistant_1', type: 'text', text: 'The analysis', time: { start: 3, end: 4 } }
      }
    }, ctx);
  });

  assert.deepEqual(contentDeltas(lines), ['findings.', ' The analysis']);
  assert.equal(ctx.sawAssistantOutput, true);
  assert.equal(ctx.lastTextPartEndedWithoutWhitespace, true);
});

test('opencode drops user-role text parts from the event stream', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_test',
        part: {
          id: 'prt_user_1',
          sessionID: 'ses_test',
          messageID: 'msg_user_1',
          type: 'text',
          text: 'echoed prompt',
          time: { start: 1, end: 2 }
        }
      }
    }, ctx);
    await handleOpenCodeEvent(messageUpdated('msg_user_1', 'user'), ctx);
  });

  assert.deepEqual(contentDeltas(lines), []);
  assert.equal(ctx.sawAssistantOutput, false);
});

test('opencode session.error emits structured send error', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'session.error',
      properties: {
        sessionID: 'ses_test',
        error: {
          name: 'APIError',
          data: {
            message: 'provider timed out'
          }
        }
      }
    }, ctx);
  });

  assert.deepEqual(sendErrors(lines), [{
    code: 'OPENCODE_SESSION_ERROR',
    error: 'provider timed out'
  }]);
  assert.equal(ctx.sawSendError, true);
});

test('opencode session.status idle is treated as the turn completion signal', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });

  await handleOpenCodeEvent({
    type: 'session.status',
    properties: {
      sessionID: 'ses_test',
      status: { type: 'busy' }
    }
  }, ctx);
  assert.equal(ctx.sawSessionIdle, false);
  assert.equal(ctx.sawTurnLive, true);

  await handleOpenCodeEvent({
    type: 'session.status',
    properties: {
      sessionID: 'ses_test',
      status: { type: 'idle' }
    }
  }, ctx);
  assert.equal(ctx.sawSessionIdle, true);
});

test('opencode event stream closure does not complete a busy turn before status is idle', async () => {
  const previousPollMs = process.env.OPENCODE_SESSION_STATUS_POLL_MS;
  const previousDrainMs = process.env.OPENCODE_EVENT_DRAIN_IDLE_MS;
  process.env.OPENCODE_SESSION_STATUS_POLL_MS = '1';
  process.env.OPENCODE_EVENT_DRAIN_IDLE_MS = '1';

  let calls = 0;
  const statuses = [
    { ses_test: { type: 'busy' } },
    {}
  ];
  const ctx = createEventContext({
    client: {
      session: {
        status: async () => ({ data: statuses[calls++] })
      }
    }
  }, '/repo', 'default', { id: 'ses_test' });
  ctx.eventStreamClosed = true;
  ctx.lastActivityAt = Date.now() - 1000;

  try {
    await waitForOpenCodeTurnIdle(ctx, { aborted: false });
  } finally {
    if (previousPollMs === undefined) {
      delete process.env.OPENCODE_SESSION_STATUS_POLL_MS;
    } else {
      process.env.OPENCODE_SESSION_STATUS_POLL_MS = previousPollMs;
    }
    if (previousDrainMs === undefined) {
      delete process.env.OPENCODE_EVENT_DRAIN_IDLE_MS;
    } else {
      process.env.OPENCODE_EVENT_DRAIN_IDLE_MS = previousDrainMs;
    }
  }

  assert.equal(calls, 2);
});

test('opencode missing status cannot complete a turn before live activity', async () => {
  const previousPollMs = process.env.OPENCODE_SESSION_STATUS_POLL_MS;
  const previousDrainMs = process.env.OPENCODE_EVENT_DRAIN_IDLE_MS;
  process.env.OPENCODE_SESSION_STATUS_POLL_MS = '1';
  process.env.OPENCODE_EVENT_DRAIN_IDLE_MS = '1';

  let completed = false;
  const ctx = createEventContext({
    client: {
      session: {
        status: async () => ({ data: {} })
      }
    }
  }, '/repo', 'default', { id: 'ses_test' });
  ctx.eventStreamClosed = true;
  ctx.lastActivityAt = Date.now() - 1000;

  const wait = waitForOpenCodeTurnIdle(ctx, { aborted: false }).then(() => {
    completed = true;
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(completed, false);

    ctx.sawTurnLive = true;
    await wait;
    assert.equal(completed, true);
  } finally {
    if (previousPollMs === undefined) {
      delete process.env.OPENCODE_SESSION_STATUS_POLL_MS;
    } else {
      process.env.OPENCODE_SESSION_STATUS_POLL_MS = previousPollMs;
    }
    if (previousDrainMs === undefined) {
      delete process.env.OPENCODE_EVENT_DRAIN_IDLE_MS;
    } else {
      process.env.OPENCODE_EVENT_DRAIN_IDLE_MS = previousDrainMs;
    }
  }
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
  ctx.sessionDiffBaselineReady = true;
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

test('opencode session.diff skips baseline session changes', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  seedOpenCodeDiffSignatures(ctx, [{
    file: '/repo/src/old.ts',
    patch: '@@ -1 +1 @@\n-const oldValue = 1\n+const oldValue = 2\n'
  }]);
  ctx.sessionDiffBaselineReady = true;

  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'session.diff',
      properties: {
        sessionID: 'ses_test',
        diff: [
          {
            file: '/repo/src/old.ts',
            patch: '@@ -1 +1 @@\n-const oldValue = 1\n+const oldValue = 2\n'
          },
          {
            file: '/repo/src/new.ts',
            patch: '@@ -1 +1 @@\n-const newValue = 1\n+const newValue = 2\n'
          }
        ]
      }
    }, ctx);
  });

  const messages = messagePayloads(lines);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.content[0].input.file_path, '/repo/src/new.ts');
});

test('opencode session.diff before baseline is seeded but not emitted', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'session.diff',
      properties: {
        sessionID: 'ses_test',
        diff: [{
          file: '/repo/src/old.ts',
          patch: '@@ -1 +1 @@\n-const oldValue = 1\n+const oldValue = 2\n'
        }]
      }
    }, ctx);
  });

  assert.deepEqual(messagePayloads(lines), []);
  ctx.sessionDiffBaselineReady = true;

  const afterBaselineLines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'session.diff',
      properties: {
        sessionID: 'ses_test',
        diff: [
          {
            file: '/repo/src/old.ts',
            patch: '@@ -1 +1 @@\n-const oldValue = 1\n+const oldValue = 2\n'
          },
          {
            file: '/repo/src/new.ts',
            patch: '@@ -1 +1 @@\n-const newValue = 1\n+const newValue = 2\n'
          }
        ]
      }
    }, ctx);
  });

  const messages = messagePayloads(afterBaselineLines);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.content[0].input.file_path, '/repo/src/new.ts');
});

test('opencode session.diff deduplicates equivalent relative and absolute paths', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  ctx.sessionDiffBaselineReady = true;
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

test('opencode history normalization preserves image file parts', () => {
  const normalized = normalizeOpenCodeMessage({
    info: { id: 'msg_user_1', role: 'user' },
    parts: [
      {
        type: 'file',
        url: 'file:///tmp/opencode-attachments-1/diagram.png',
        filename: 'diagram.png',
        mime: 'image/png'
      },
      {
        type: 'text',
        text: 'What changed in this screenshot?'
      }
    ]
  });

  assert.deepEqual(normalized.message.content, [
    {
      type: 'image',
      source: {
        type: 'url',
        url: 'file:///tmp/opencode-attachments-1/diagram.png',
        media_type: 'image/png'
      }
    },
    {
      type: 'text',
      text: 'What changed in this screenshot?'
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

function thinkingDeltas(lines) {
  return lines
    .filter((line) => line.startsWith('[THINKING_DELTA] '))
    .map((line) => JSON.parse(line.slice('[THINKING_DELTA] '.length)));
}

test('opencode reasoning deltas with reasoning_content field emit thinking blocks', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent(messageUpdated('msg_1'), ctx);

    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_test',
        messageID: 'msg_1',
        partID: 'prt_reasoning_1',
        field: 'reasoning_content',
        delta: 'Let me'
      }
    }, ctx);

    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_test',
        messageID: 'msg_1',
        partID: 'prt_reasoning_1',
        field: 'reasoning_content',
        delta: ' think about this.'
      }
    }, ctx);

    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_test',
        messageID: 'msg_1',
        part: {
          id: 'prt_reasoning_1',
          type: 'reasoning',
          text: 'Let me think about this.'
        }
      }
    }, ctx);
  });

  const tDeltas = thinkingDeltas(lines);
  assert.equal(tDeltas.length, 2);
  assert.equal(tDeltas[0], 'Let me');
  assert.equal(tDeltas[1], ' think about this.');

  const cDeltas = contentDeltas(lines);
  assert.equal(cDeltas.length, 0, 'reasoning deltas should not emit content deltas');
});

test('opencode reasoning deltas from part type emit thinking blocks', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent(messageUpdated('msg_1'), ctx);

    await handleOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_test',
        messageID: 'msg_1',
        part: {
          id: 'prt_reason_2',
          type: 'reasoning',
          text: ''
        }
      }
    }, ctx);

    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_test',
        messageID: 'msg_1',
        partID: 'prt_reason_2',
        field: 'text',
        delta: 'Analyzing code...'
      }
    }, ctx);
  });

  const tDeltas = thinkingDeltas(lines);
  assert.equal(tDeltas.length, 1);
  assert.equal(tDeltas[0], 'Analyzing code...');

  const cDeltas = contentDeltas(lines);
  assert.equal(cDeltas.length, 0, 'reasoning part deltas should not emit content deltas');
});

test('opencode non-reasoning unknown field deltas are skipped', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_test' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_test',
        messageID: 'msg_1',
        partID: 'prt_unknown_1',
        field: 'some_other_field',
        delta: 'should be skipped'
      }
    }, ctx);
  });

  const tDeltas = thinkingDeltas(lines);
  const cDeltas = contentDeltas(lines);
  assert.equal(tDeltas.length, 0);
  assert.equal(cDeltas.length, 0, 'unknown field deltas should be skipped');
});

test('opencode session filtering ignores events before session id is assigned', () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: '' });
  const props = {
    sessionID: 'ses_foreign',
    messageID: 'msg_1',
    partID: 'prt_text_1',
    field: 'text',
    delta: 'leaked text'
  };

  assert.equal(shouldHandleSessionEvent(ctx, props), false);
});

test('opencode session filtering rejects foreign session events', () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: 'ses_active' });
  const props = {
    sessionID: 'ses_foreign',
    messageID: 'msg_1',
    partID: 'prt_text_1',
    field: 'text',
    delta: 'leaked text'
  };

  assert.equal(shouldHandleSessionEvent(ctx, props), false);
  assert.equal(shouldHandleSessionEvent(ctx, {
    ...props,
    sessionID: 'ses_active'
  }), true);
});

test('opencode ignores foreign session deltas before session id is assigned', async () => {
  const ctx = createEventContext(null, '/repo', 'default', { id: '' });
  const lines = await captureConsole(async () => {
    await handleOpenCodeEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'ses_foreign',
        messageID: 'msg_1',
        partID: 'prt_text_1',
        field: 'text',
        delta: 'leaked text'
      }
    }, ctx);
  });

  assert.equal(contentDeltas(lines).length, 0);
  assert.equal(ctx.sessionRef.id, '');
});
