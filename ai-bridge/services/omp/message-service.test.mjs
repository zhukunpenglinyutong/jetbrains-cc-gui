import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOmpArgs, runOmpTurn } from './message-service.js';
import { fakeOmp } from './testing/fake-omp.js';

const STATS = { sessionId: 'sess-1', contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 } };
const DONE = { type: 'prompt_result', id: 'prompt', agentInvoked: true, status: 'completed', sessionSettled: true };

function textDelta(delta) {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } };
}

/**
 * Run one turn against a fake whose `prompt` plays `promptSteps`; returns everything it emitted.
 * `script` adds commands to the fake's `on`, `scriptFields` adds top-level script fields (`onClose`).
 */
async function runTurn(promptSteps, { script = {}, scriptFields = {}, options = {}, onEvent } = {}) {
  const omp = fakeOmp({
    ...scriptFields,
    on: {
      set_event_filter: [{ respond: { events: [], messageUpdates: 'delta' } }],
      get_session_stats: [{ respond: STATS }],
      prompt: promptSteps,
      ...script,
    },
  });
  const events = [];
  const record = (kind) => (value) => {
    events.push([kind, value]);
    onEvent?.(kind, value);
  };
  try {
    const result = await runOmpTurn({
      createClient: omp.createClient,
      message: 'hello',
      cwd: '/work/project',
      emit: {
        sessionId: record('sessionId'),
        contentDelta: record('content'),
        thinkingDelta: record('thinking'),
        toolUse: record('toolUse'),
        toolResult: record('toolResult'),
        usage: record('usage'),
      },
      requestPermission: async () => true,
      requestAnswers: async () => null,
      ...options,
    });
    return { result, events, received: omp.received() };
  } finally {
    omp.cleanup();
  }
}

test('buildOmpArgs starts rpc-ui and resumes the exact session', () => {
  assert.deepEqual(buildOmpArgs({ sessionId: '  abc-123  ' }), ['--mode', 'rpc-ui', '--resume', 'abc-123']);
});

test('buildOmpArgs passes model, thinking level and approval mode', () => {
  assert.deepEqual(
    buildOmpArgs({ sessionId: 'abc', model: 'slow', reasoningEffort: 'xhigh', approvalMode: 'write' }),
    ['--mode', 'rpc-ui', '--model', 'slow', '--resume', 'abc', '--thinking', 'xhigh', '--approval-mode', 'write'],
  );
});

test('buildOmpArgs leaves OMP\'s own defaults alone when nothing is chosen', () => {
  // No model flag for the default aliases, no --thinking without a level, and
  // no --approval-mode for "default" (OMP's tools.approvalMode decides).
  for (const model of ['auto', 'default', '', 'OMP Default']) {
    assert.deepEqual(
      buildOmpArgs({ model, reasoningEffort: '', approvalMode: 'default' }),
      ['--mode', 'rpc-ui'],
      `model=${model}`,
    );
  }
  assert.deepEqual(buildOmpArgs({ reasoningEffort: 'ludicrous', approvalMode: 'bypassPermissions' }), ['--mode', 'rpc-ui']);
});

test('buildOmpArgs omits --resume for an empty or unsafe session id', () => {
  for (const sessionId of ['', '   ', '.', '..', '../other', 'a/b', 'a\\b']) {
    assert.deepEqual(buildOmpArgs({ sessionId }), ['--mode', 'rpc-ui'], `sessionId=${sessionId}`);
  }
});

test('a turn streams the session id, thinking, text and per-step usage', async () => {
  const { result, events, received } = await runTurn([
    { respond: null },
    { emit: { type: 'agent_start' } },
    { emit: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Let me see' } } },
    { emit: textDelta('Hel') },
    { emit: textDelta('lo') },
    { emit: { type: 'message_end', message: { role: 'user', content: [] } } },
    {
      emit: {
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 4, output: 10, cacheRead: 100, cacheWrite: 20, totalTokens: 134, cost: { total: 0.01 } },
        },
      },
    },
    { emit: DONE },
  ]);

  assert.deepEqual(result, { status: 'completed' });
  assert.deepEqual(events, [
    ['sessionId', 'sess-1'],
    ['thinking', 'Let me see'],
    ['content', 'Hel'],
    ['content', 'lo'],
    ['usage', {
      input_tokens: 4,
      output_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      total_tokens: 134,
      cost_usd: 0.01,
      model_context_window: 200000,
    }],
  ]);
  assert.deepEqual(received.find((frame) => frame.type === 'prompt'), { id: 'prompt', type: 'prompt', message: 'hello' });
});

test('a new session is announced right before the first assistant reply when omp sends no agent_start', async () => {
  const { events } = await runTurn([
    { respond: null },
    { emit: textDelta('Hi') },
    { emit: { type: 'message_end', message: { role: 'user', content: [] } } },
    { emit: { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 2, totalTokens: 3 } } } },
    { emit: DONE },
  ]);
  const kinds = events.map(([kind]) => kind);
  assert.deepEqual(kinds, ['content', 'sessionId', 'usage']);
  assert.equal(events[1][1], 'sess-1');
});

test('images travel inside the prompt command', async () => {
  const images = [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }];
  const { received } = await runTurn([{ respond: null }, { emit: DONE }], { options: { images } });
  assert.deepEqual(received.find((frame) => frame.type === 'prompt').images, images);
});

test('tools show at start, except those whose card needs the result', async () => {
  const { events } = await runTurn([
    { respond: null },
    { emit: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } } },
    { emit: { type: 'tool_execution_start', toolCallId: 't2', toolName: 'edit', args: { input: '[a.ts#1A2B]\nPUT 1.=1:\n+b' } } },
    {
      emit: {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'a.ts\n' }], details: {} },
      },
    },
    {
      emit: {
        type: 'tool_execution_end',
        toolCallId: 't2',
        toolName: 'edit',
        isError: false,
        result: { content: [{ type: 'text', text: '[a.ts#3C4D]' }], details: { path: '/work/project/a.ts', diff: '-1|a\n+1|b' } },
      },
    },
    { emit: DONE },
  ]);

  assert.deepEqual(events.filter(([kind]) => kind.startsWith('tool')), [
    ['toolUse', { id: 't1', name: 'bash', input: { command: 'ls' } }],
    ['toolResult', { toolUseId: 't1', content: 'a.ts\n', isError: false }],
    ['toolUse', { id: 't2', name: 'Edit', input: { file_path: '/work/project/a.ts', old_string: 'a', new_string: 'b' } }],
    ['toolResult', { toolUseId: 't2', content: '[a.ts#3C4D]', isError: false }],
  ]);
});

test('a held-back call is still shown when the turn ends before its result', async () => {
  const { events } = await runTurn([
    { respond: null },
    { emit: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { input: '[src/a.ts#1A2B]\nCUT 1.=1' } } },
    { emit: { ...DONE, status: 'aborted' } },
  ]);
  assert.deepEqual(events.filter(([kind]) => kind.startsWith('tool')), [
    ['toolUse', { id: 't1', name: 'edit', input: { input: '[src/a.ts#1A2B]\nCUT 1.=1', file_path: 'src/a.ts' } }],
  ]);
});

test('a tool approval is decided in the permission dialog and answered before the tool runs', async () => {
  const asked = [];
  const { events, received } = await runTurn([
    { respond: null },
    { emit: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'rm -rf build' } } },
    {
      emit: {
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'select',
        title: 'Allow tool: bash\nCommand: rm -rf build',
        options: ['Approve', 'Approve bash for this session', 'Deny'],
      },
    },
    { waitFor: 'extension_ui_response' },
    {
      emit: {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'Tool call denied by user' }] },
      },
    },
    { emit: DONE },
  ], {
    options: {
      requestPermission: async (toolName, inputs) => {
        asked.push({ toolName, inputs });
        return false;
      },
    },
  });

  assert.deepEqual(asked, [{ toolName: 'Bash', inputs: { command: 'rm -rf build', cwd: '/work/project' } }]);
  assert.deepEqual(
    received.find((frame) => frame.type === 'extension_ui_response'),
    { type: 'extension_ui_response', id: 'ui-1', value: 'Deny' },
  );
  assert.deepEqual(events.at(-1), ['toolResult', { toolUseId: 't1', content: 'Tool call denied by user', isError: true }]);
});

test('an approval is shown for the call it prints, not for another running call of the tool', async () => {
  const asked = [];
  await runTurn([
    { respond: null },
    { emit: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 6' } } },
    {
      emit: {
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'select',
        title: 'Allow tool: bash\nCommand: echo danger',
        options: ['Approve', 'Approve bash for this session', 'Deny'],
      },
    },
    { waitFor: 'extension_ui_response' },
    { emit: { type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'echo danger' } } },
    {
      emit: {
        type: 'tool_execution_end',
        toolCallId: 't2',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'danger\n' }] },
      },
    },
    { emit: DONE },
  ], {
    options: {
      requestPermission: async (toolName, inputs) => {
        asked.push({ toolName, inputs });
        return true;
      },
    },
  });

  assert.deepEqual(asked, [{ toolName: 'bash', inputs: { text: 'Command: echo danger' } }]);
});

test('an approval that prints nothing about its call shows every running call of the tool', async () => {
  const asked = [];
  const approval = {
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Allow tool: read',
    options: ['Approve', 'Approve read for this session', 'Deny'],
  };
  await runTurn([
    { respond: null },
    { emit: { type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: 'a.txt' } } },
    { emit: approval },
    // The prompt is about r2: OMP writes it before r2's start event reaches the stream.
    { delay: 40 },
    { emit: { type: 'tool_execution_start', toolCallId: 'r2', toolName: 'read', args: { path: 'ssh://host/etc/hostname' } } },
    { waitFor: 'extension_ui_response' },
    { emit: DONE },
  ], {
    options: {
      requestPermission: async (toolName, inputs) => {
        asked.push({ toolName, inputs });
        return true;
      },
    },
  });

  assert.deepEqual(asked, [{
    toolName: 'read',
    inputs: {
      text: 'OMP did not say which read call it is asking about. Running now:\n'
        + '1. {"path":"a.txt"}\n'
        + '2. {"path":"ssh://host/etc/hostname"}',
    },
  }]);
});

test('a bash prompt that reaches the bridge before its own call still gets the command dialog', async () => {
  const asked = [];
  await runTurn([
    { respond: null },
    {
      emit: {
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'select',
        title: 'Allow tool: bash\nCommand: rm -rf build',
        options: ['Approve', 'Approve bash for this session', 'Deny'],
      },
    },
    { delay: 40 },
    { emit: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'rm -rf build' } } },
    { waitFor: 'extension_ui_response' },
    { emit: DONE },
  ], {
    options: {
      requestPermission: async (toolName, inputs) => {
        asked.push({ toolName, inputs });
        return true;
      },
    },
  });

  assert.deepEqual(asked, [{ toolName: 'Bash', inputs: { command: 'rm -rf build', cwd: '/work/project' } }]);
});

test('a local slash command prints its output and ends without a model turn', async () => {
  const { result, events } = await runTurn([
    { emit: { type: 'command_output', text: 'Session: sess-1\nCWD: /work/project' } },
    { respond: { agentInvoked: false } },
  ]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.filter(([kind]) => kind === 'content'), [['content', 'Session: sess-1\nCWD: /work/project\n']]);
  // No agent run happened, so omp wrote no session file: the id must not be announced.
  assert.deepEqual(events.filter(([kind]) => kind === 'sessionId'), []);
});

test('a builtin that keeps working after its acknowledgement is left to finish', async () => {
  const { result, events } = await runTurn([{ respond: { agentInvoked: false } }], {
    scriptFields: {
      onClose: [{ delay: 400 }, { emit: { type: 'command_output', text: 'Handoff saved' } }],
    },
    options: { closeGraceMs: 100 },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.filter(([kind]) => kind === 'content').map(([, text]) => text), ['Handoff saved\n']);
});

test('stopping a local command that is still working ends the turn', async () => {
  const stop = new AbortController();
  const started = Date.now();
  const { result } = await runTurn([
    { respond: { agentInvoked: false } },
    { delay: 100 },
    { emit: { type: 'command_output', text: 'working' } },
  ], {
    scriptFields: { onClose: [{ delay: 60_000 }] },
    options: { abortSignal: stop.signal },
    onEvent: (kind) => {
      if (kind === 'content') stop.abort();
    },
  });
  assert.equal(result.status, 'aborted');
  assert.ok(Date.now() - started < 10_000);
});

test('the turn stays open while background work can still wake the agent', async () => {
  const { events } = await runTurn([
    { respond: null },
    { emit: textDelta('started the build') },
    { emit: { ...DONE, sessionSettled: false } },
    { delay: 50 },
    { emit: textDelta(' - build finished') },
    { emit: { type: 'session_settled' } },
  ]);
  assert.deepEqual(events.filter(([kind]) => kind === 'content').map(([, text]) => text), [
    'started the build',
    ' - build finished',
  ]);
});

test('a failed provider turn rejects with OMP\'s error message', async () => {
  await assert.rejects(
    runTurn([
      { respond: null },
      {
        emit: {
          ...DONE,
          status: 'error',
          error: { message: 'overloaded_error: provider returned error 529', retryable: true },
        },
      },
    ]),
    /overloaded_error: provider returned error 529/,
  );
});

test('a prompt OMP refuses rejects with the refusal', async () => {
  await assert.rejects(runTurn([{ fail: 'No model selected' }]), /No model selected/);
  // Refused after it was acknowledged: a second response with the prompt's id.
  await assert.rejects(
    runTurn([
      { respond: null },
      { emit: { id: 'prompt', type: 'response', command: 'prompt', success: false, error: 'Image could not be read' } },
    ]),
    /Image could not be read/,
  );
});

test('a crash mid-turn rejects with the exit code and stderr', async () => {
  await assert.rejects(
    runTurn([{ respond: null }, { emit: textDelta('partial') }, { stderr: 'panic: out of memory\n' }, { exit: 7 }]),
    (error) => {
      assert.match(error.message, /exited with code 7/);
      assert.match(error.message, /out of memory/);
      return true;
    },
  );
});

test('stopping the turn sends abort and resolves once OMP confirms', async () => {
  const stop = new AbortController();
  const { result, received } = await runTurn([{ respond: null }, { emit: textDelta('working') }], {
    script: { abort: [{ emit: { ...DONE, status: 'aborted' } }] },
    options: { abortSignal: stop.signal },
    onEvent: (kind) => {
      if (kind === 'content') stop.abort();
    },
  });
  assert.equal(result.status, 'aborted');
  assert.ok(received.some((frame) => frame.type === 'abort'));
});

test('stopping a turn OMP does not wind down kills the process and still resolves', async () => {
  const stop = new AbortController();
  // The fake has no `abort` step: the prompt never completes on its own.
  const { result } = await runTurn([{ respond: null }, { emit: textDelta('working') }], {
    options: { abortSignal: stop.signal },
    onEvent: (kind) => {
      if (kind === 'content') stop.abort();
    },
  });
  assert.equal(result.status, 'aborted');
});

test('an omp without the optional setup commands still runs the turn', async () => {
  const { result, events } = await runTurn([{ respond: null }, { emit: textDelta('hi') }, { emit: DONE }], {
    script: {
      set_event_filter: [{ fail: 'Unknown command: set_event_filter' }],
      get_session_stats: [{ fail: 'Unknown command: get_session_stats' }],
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [['content', 'hi']]);
});
