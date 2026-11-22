import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  approvalDescribesCall,
  buildPermissionRequest,
  createUiBridge,
  describeUnidentifiedCall,
  parseApprovalRequest,
} from './ui-bridge.js';

const CWD = resolve('/work/project');
const OTHER = 'Other (type your own)';
const DONE = '✔ Done selecting';

function approvalFrame(id, title, options = ['Approve', 'Approve bash for this session', 'Deny']) {
  return { type: 'extension_ui_request', id, method: 'select', title, options };
}

/**
 * A bridge whose dialogs are answered by the given stubs; `sent` collects the responses.
 *
 * @param {object[]} [options.calls] the running tool calls
 * @param {object[]} [options.late] calls whose start event reaches the bridge only while it waits for one
 */
function harness({ permission = async () => true, answers = async () => null, calls = [], late = [] } = {}) {
  const sent = [];
  const asked = { permission: [], answers: [] };
  const queue = [...calls];
  const starting = [...late];
  const handled = [];
  const awaited = new Map();
  const real = createUiBridge({
    respond: (frame) => {
      sent.push(frame);
      awaited.get(frame.id)?.(frame);
    },
    requestPermission: async (toolName, inputs) => {
      asked.permission.push({ toolName, inputs });
      return permission(toolName, inputs);
    },
    requestAnswers: async (input) => {
      asked.answers.push(input);
      return answers(input);
    },
    claimToolCall: (toolName, describes) => {
      const index = queue.findIndex((call) => call.name === toolName && describes(call.args));
      return index >= 0 ? queue.splice(index, 1)[0] : undefined;
    },
    runningToolCalls: (toolName) => queue.filter((call) => call.name === toolName),
    waitForToolStart: async (toolName) => {
      const index = starting.findIndex((call) => call.name === toolName);
      if (index < 0) return false;
      queue.push(starting.splice(index, 1)[0]);
      return true;
    },
    cwd: CWD,
  });
  const bridge = {
    handle: (frame) => {
      const done = real.handle(frame);
      handled.push(done);
      return done;
    },
  };
  /** Resolves once every request handed over so far has been dealt with. */
  const idle = () => Promise.all(handled);
  /** Send a request the way OMP does; resolves with the bridge's response to it. */
  const request = (frame) => new Promise((resolveResponse) => {
    const id = `req-${awaited.size + 1}`;
    awaited.set(id, resolveResponse);
    bridge.handle({ type: 'extension_ui_request', id, ...frame });
  });
  return { bridge, sent, asked, idle, request };
}

/**
 * OMP's side of a checkbox question, as its `ask` tool runs it over RPC: the
 * options go out as a `select`, the answer toggles one of them, and the select
 * goes out again until the answer is the "Done" row.
 *
 * @param {Set<string>} [question.held] the checked labels; preselected ones are passed in
 * @param {boolean} [question.doneBeforeOther] the rows of omp 18.12: "Done" comes before
 *   "Other", and only once something is selected
 * @returns {Promise<{ checked: string[], typed: string|undefined }|undefined>} undefined when cancelled
 */
async function ompCheckboxQuestion(request, {
  title, labels, held = new Set(), required = false, doneBeforeOther = false,
}) {
  let typed;
  for (;;) {
    const count = held.size + (typed === undefined ? 0 : 1);
    const response = await request({
      method: 'select',
      title: `${count > 0 ? `(${count} selected) ` : ''}${title}`,
      options: doneBeforeOther
        ? [...labels, ...(count > 0 ? [DONE] : []), OTHER]
        : [...labels, OTHER, ...(!required || count > 0 ? [DONE] : [])],
    });
    if (response.cancelled) return undefined;
    if (response.value === DONE) return { checked: labels.filter((label) => held.has(label)), typed };
    if (response.value === OTHER) {
      // Selecting "Other" again drops the text; otherwise OMP asks for it.
      if (typed !== undefined) {
        typed = undefined;
      } else {
        const text = await request({ method: 'input', title });
        if (text.value?.trim()) typed = text.value;
      }
    } else if (labels.includes(response.value) && !held.delete(response.value)) {
      held.add(response.value);
    }
  }
}

/** A question dialog that gives one scripted answer per question; `undefined` dismisses it. */
function answering(...replies) {
  return async (input) => {
    const [question] = input.questions;
    const reply = replies.shift();
    const value = typeof reply === 'function' ? reply(question) : reply;
    return value === undefined ? {} : { [question.id]: value };
  };
}

test('parseApprovalRequest reads the tool and its details, and picks the once-only choices', () => {
  assert.deepEqual(
    parseApprovalRequest(approvalFrame('1', 'Allow tool: bash\nCommand: echo hi > out.txt')),
    { toolName: 'bash', details: 'Command: echo hi > out.txt', approve: 'Approve', deny: 'Deny' },
  );
  // "Ask and remember" mode offers grants; the plugin still answers for this call only.
  const cached = approvalFrame('2', 'Allow tool: read\nPath: src/a.ts', [
    'Approve Directory: src',
    'Always Approve Directory: src',
    'Approve File',
    'Always Approve File',
    'Approve Once',
    'Deny',
  ]);
  assert.equal(parseApprovalRequest(cached).approve, 'Approve Once');
});

test('parseApprovalRequest leaves ordinary selects alone', () => {
  assert.equal(parseApprovalRequest({ method: 'select', title: 'Pick one', options: ['A', 'B'] }), null);
  // A tool question that merely starts like an approval but offers no deny choice.
  assert.equal(parseApprovalRequest(approvalFrame('1', 'Allow tool: bash', ['Approve', 'Later'])), null);
  assert.equal(parseApprovalRequest({ method: 'input', title: 'Allow tool: bash' }), null);
});

test('buildPermissionRequest shows bash and file writes in the shapes the plugin dialog knows', () => {
  assert.deepEqual(
    buildPermissionRequest({ toolName: 'bash', details: 'Command: ls' }, { args: { command: 'ls' } }, { cwd: CWD }),
    { toolName: 'Bash', inputs: { command: 'ls', cwd: CWD } },
  );
  assert.deepEqual(
    buildPermissionRequest(
      { toolName: 'write', details: 'Path: notes.md' },
      { args: { path: 'notes.md', content: 'hello' } },
      { cwd: CWD },
    ),
    { toolName: 'Write', inputs: { file_path: resolve(CWD, 'notes.md'), content: 'hello' } },
  );
});

test('buildPermissionRequest falls back to OMP\'s own description of the call', () => {
  // A device write is not a file write, and an edit patch has no before/after text.
  assert.deepEqual(
    buildPermissionRequest({ toolName: 'write', details: 'Path: xd://lsp' }, { args: { path: 'xd://lsp', content: '{}' } }, { cwd: CWD }),
    { toolName: 'write', inputs: { text: 'Path: xd://lsp' } },
  );
  assert.deepEqual(
    buildPermissionRequest({ toolName: 'edit', details: 'Path: a.ts\n-1|x\n+1|y' }, { args: { input: '[a.ts#1A2B]' } }),
    { toolName: 'edit', inputs: { text: 'Path: a.ts\n-1|x\n+1|y' } },
  );
});

test('describeUnidentifiedCall names every running call, and says so when there is none', () => {
  assert.equal(
    describeUnidentifiedCall({ toolName: 'read', details: '' }, [
      { args: { path: 'a.txt' } },
      { args: { path: 'ssh://host/etc/hostname' } },
    ]),
    'OMP did not say which read call it is asking about. Running now:\n'
      + '1. {"path":"a.txt"}\n'
      + '2. {"path":"ssh://host/etc/hostname"}',
  );
  assert.equal(
    describeUnidentifiedCall({ toolName: 'read', details: 'Reason: Restricted folder: /srv' }, []),
    'Reason: Restricted folder: /srv\n\n'
      + 'OMP did not say which read call it is asking about, and no read call has started yet.',
  );
  // Arguments that would flood the dialog are cut the way OMP cuts its own: 2000 characters, then the rest counted.
  const long = describeUnidentifiedCall({ toolName: 'github', details: '' }, [{ args: { body: 'x'.repeat(3000) } }]);
  assert.match(long, /^1\. \{"body":"x{1991}\[…1011ch elided…\]$/m);
});

test('an approval is answered with the choice matching the permission dialog', async () => {
  const allowed = harness({ permission: async () => true, calls: [{ name: 'bash', args: { command: 'npm test' } }] });
  allowed.bridge.handle(approvalFrame('ui-1', 'Allow tool: bash\nCommand: npm test'));
  await allowed.idle();
  assert.deepEqual(allowed.asked.permission, [{ toolName: 'Bash', inputs: { command: 'npm test', cwd: CWD } }]);
  assert.deepEqual(allowed.sent, [{ type: 'extension_ui_response', id: 'ui-1', value: 'Approve' }]);

  const denied = harness({ permission: async () => false });
  denied.bridge.handle(approvalFrame('ui-2', 'Allow tool: bash\nCommand: rm -rf build'));
  await denied.idle();
  assert.deepEqual(denied.sent, [{ type: 'extension_ui_response', id: 'ui-2', value: 'Deny' }]);
});

test('a permission dialog that fails denies the call', async () => {
  const { bridge, sent, idle } = harness({ permission: async () => { throw new Error('ipc down'); } });
  bridge.handle(approvalFrame('ui-1', 'Allow tool: bash\nCommand: ls'));
  await idle();
  assert.deepEqual(sent, [{ type: 'extension_ui_response', id: 'ui-1', value: 'Deny' }]);
});

test('approvals for the same tool are matched to its calls in order', async () => {
  const { bridge, asked, idle } = harness({
    calls: [{ name: 'bash', args: { command: 'first' } }, { name: 'bash', args: { command: 'second' } }],
  });
  bridge.handle(approvalFrame('a', 'Allow tool: bash\nCommand: first'));
  bridge.handle(approvalFrame('b', 'Allow tool: bash\nCommand: second'));
  await idle();
  assert.deepEqual(asked.permission.map((request) => request.inputs.command), ['first', 'second']);
});

test('prompts that arrive in the opposite order to the calls are matched by content', async () => {
  const { bridge, asked, idle } = harness({
    calls: [{ name: 'bash', args: { command: 'first' } }, { name: 'bash', args: { command: 'second' } }],
  });
  bridge.handle(approvalFrame('a', 'Allow tool: bash\nCommand: second'));
  bridge.handle(approvalFrame('b', 'Allow tool: bash\nCommand: first'));
  await idle();
  assert.deepEqual(asked.permission.map((request) => request.inputs.command), ['second', 'first']);
});

test('a prompt no running call matches shows OMP\'s own text and leaves the calls unclaimed', async () => {
  const running = { name: 'bash', args: { command: 'sleep 6' } };
  const { bridge, asked, idle } = harness({ calls: [running] });
  bridge.handle(approvalFrame('a', 'Allow tool: bash\nCommand: echo danger'));
  await idle();
  assert.deepEqual(asked.permission, [{ toolName: 'bash', inputs: { text: 'Command: echo danger' } }]);

  // The call is still there for its own prompt.
  bridge.handle(approvalFrame('b', 'Allow tool: bash\nCommand: sleep 6'));
  await idle();
  assert.deepEqual(asked.permission[1], { toolName: 'Bash', inputs: { command: 'sleep 6', cwd: CWD } });
});

test('a command OMP printed cut to 2000 characters still claims its call, and the dialog shows all of it', async () => {
  const command = `echo ${'x'.repeat(2495)}`;
  const { bridge, asked, idle } = harness({ calls: [{ name: 'bash', args: { command } }] });
  bridge.handle(approvalFrame('a', `Allow tool: bash\nCommand: ${command.slice(0, 2000)}[…500ch elided…]`));
  await idle();
  assert.deepEqual(asked.permission, [{ toolName: 'Bash', inputs: { command, cwd: CWD } }]);
});

test('a write prompt claims the call even though OMP trimmed the file\'s final newline', async () => {
  const { bridge, asked, idle } = harness({
    calls: [{ name: 'write', args: { path: 'notes.md', content: 'hello\n' } }],
  });
  bridge.handle(approvalFrame('a', 'Allow tool: write\nPath: notes.md\nContent:\nhello'));
  await idle();
  assert.deepEqual(asked.permission, [
    { toolName: 'Write', inputs: { file_path: resolve(CWD, 'notes.md'), content: 'hello\n' } },
  ]);
});

test('a write to a path OMP rewrites is shown with OMP\'s own text', async () => {
  const details = 'Path: @/tmp/other/out.txt\nContent:\nhello';
  const { bridge, asked, idle } = harness({
    calls: [{ name: 'write', args: { path: '@/tmp/other/out.txt', content: 'hello' } }],
  });
  bridge.handle(approvalFrame('a', `Allow tool: write\n${details}`));
  await idle();
  assert.deepEqual(asked.permission, [{ toolName: 'write', inputs: { text: details } }]);
});

test('approvalDescribesCall compares the printed value with the whole one', () => {
  const bash = (details) => ({ toolName: 'bash', details });
  assert.equal(approvalDescribesCall(bash('Command: echo danger'), { command: 'echo danger' }), true);
  assert.equal(approvalDescribesCall(bash('Command: echo'), { command: 'echo danger' }), false);
  assert.equal(approvalDescribesCall(bash('Command: echo danger'), { command: 'echo' }), false);
  assert.equal(approvalDescribesCall(bash('Reason: why\nCommand: a\nb'), { command: 'a\nb' }), true);
  assert.equal(approvalDescribesCall(bash('Command: ls'), {}), false);
  assert.equal(approvalDescribesCall(bash('Command: ls'), undefined), false);

  const write = (details) => ({ toolName: 'write', details });
  const args = { path: 'a.txt', content: 'one' };
  assert.equal(approvalDescribesCall(write('Path: a.txt\nContent:\none'), args), true);
  assert.equal(approvalDescribesCall(write('Path: b.txt\nContent:\none'), args), false);
  assert.equal(approvalDescribesCall(write('Path: a.txt\nContent:\ntwo'), args), false);
  assert.equal(approvalDescribesCall(write('Path: a.txt\nContent:'), { path: 'a.txt', content: '' }), true);

  // No other tool prints its call in a form that can be compared.
  assert.equal(approvalDescribesCall({ toolName: 'browser', details: '' }, { action: 'open' }), false);
  assert.equal(approvalDescribesCall({ toolName: 'read', details: 'Path: a.txt' }, { path: 'a.txt' }), false);
});

test('a prompt that prints nothing about its call lists every running call instead of picking one', async () => {
  const { bridge, asked, idle } = harness({
    calls: [{ name: 'read', args: { path: 'a.txt' } }, { name: 'bash', args: { command: 'ls' } }],
    // The call the prompt is really about: its start event trails the prompt.
    late: [{ name: 'read', args: { path: 'ssh://host/etc/hostname' } }],
  });
  bridge.handle(approvalFrame('a', 'Allow tool: read'));
  await idle();
  assert.deepEqual(asked.permission, [{
    toolName: 'read',
    inputs: {
      text: 'OMP did not say which read call it is asking about. Running now:\n'
        + '1. {"path":"a.txt"}\n'
        + '2. {"path":"ssh://host/etc/hostname"}',
    },
  }]);
});

test('a line OMP adds on its own is not a description of the call', async () => {
  const { bridge, asked, idle } = harness({ calls: [{ name: 'read', args: { path: '/srv/secret' } }] });
  bridge.handle(approvalFrame('a', 'Allow tool: read\nReason: Restricted folder: /srv'));
  await idle();
  assert.deepEqual(asked.permission.map((request) => request.inputs.text), [
    'Reason: Restricted folder: /srv\n\n'
      + 'OMP did not say which read call it is asking about. Running now:\n'
      + '1. {"path":"/srv/secret"}',
  ]);
});

test('a tool that describes its own call is shown with that description, not with a running call\'s arguments', async () => {
  const { bridge, asked, idle } = harness({ calls: [{ name: 'edit', args: { input: '[b.ts#0000]\nCUT 1.=9' } }] });
  bridge.handle(approvalFrame('a', 'Allow tool: edit\nPath: a.ts\n-1|x\n+1|y'));
  await idle();
  assert.deepEqual(asked.permission, [{ toolName: 'edit', inputs: { text: 'Path: a.ts\n-1|x\n+1|y' } }]);
});

test('a bash prompt that arrives before its own call waits for the call to start', async () => {
  const { bridge, asked, idle } = harness({
    calls: [{ name: 'bash', args: { command: 'sleep 6' } }],
    late: [{ name: 'bash', args: { command: 'echo unrelated' } }, { name: 'bash', args: { command: 'rm -rf build' } }],
  });
  bridge.handle(approvalFrame('a', 'Allow tool: bash\nCommand: rm -rf build'));
  await idle();
  assert.deepEqual(asked.permission, [{ toolName: 'Bash', inputs: { command: 'rm -rf build', cwd: CWD } }]);
});

test('a select is asked as one question and answered with the chosen option', async () => {
  const { bridge, sent, asked, idle } = harness({ answers: async () => ({ 'ui-1': 'SQLite' }) });
  bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Which database?',
    options: ['Postgres', 'SQLite'],
    optionDetails: [{ description: 'Needs a server' }, {}],
  });
  await idle();
  assert.deepEqual(asked.answers, [{
    provider: 'omp',
    questions: [{
      id: 'ui-1',
      question: 'Which database?',
      header: '',
      options: [{ label: 'Postgres', description: 'Needs a server' }, { label: 'SQLite', description: '' }],
      multiSelect: false,
      // OMP offers no "Other" row here, so the dialog must not offer a text box either.
      choiceOnly: true,
    }],
  }]);
  assert.deepEqual(sent, [{ type: 'extension_ui_response', id: 'ui-1', value: 'SQLite' }]);
});

test('free text on a choice question goes through OMP\'s "Other" row and its follow-up input', async () => {
  const { bridge, sent, asked, idle } = harness({ answers: async () => ({ 'ui-1': 'DuckDB' }) });
  bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Which database?',
    options: ['Postgres', 'SQLite', 'Other (type your own)'],
  });
  // OMP reacts to "Other" by asking for the text; the user already typed it.
  bridge.handle({ type: 'extension_ui_request', id: 'ui-2', method: 'input', title: 'Which database?' });
  await idle();
  assert.deepEqual(asked.answers[0].questions[0].options.map((option) => option.label), ['Postgres', 'SQLite']);
  assert.equal('choiceOnly' in asked.answers[0].questions[0], false);
  assert.equal(asked.answers.length, 1);
  assert.deepEqual(sent, [
    { type: 'extension_ui_response', id: 'ui-1', value: 'Other (type your own)' },
    { type: 'extension_ui_response', id: 'ui-2', value: 'DuckDB' },
  ]);
});

test('typed text is not carried over to an unrelated later input', async () => {
  const replies = [{ 'ui-1': 'DuckDB' }, { 'ui-2': 'A' }, { 'ui-3': 'my note' }];
  const { bridge, sent, idle } = harness({ answers: async () => replies.shift() });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'DB?', options: ['Postgres', 'Other (type your own)'] });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Pick', options: ['A', 'B'] });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Note' });
  await idle();
  assert.deepEqual(sent.map((frame) => frame.value), ['Other (type your own)', 'A', 'my note']);
});

test('a dismissed question, or free text where only options are valid, cancels the request', async () => {
  const dismissed = harness({ answers: async () => null });
  dismissed.bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A', 'B'] });
  await dismissed.idle();
  assert.deepEqual(dismissed.sent, [{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);

  const typed = harness({ answers: async () => ({ 'ui-1': 'neither' }) });
  typed.bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A', 'B'] });
  await typed.idle();
  assert.deepEqual(typed.sent, [{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }]);
});

test('confirm takes yes or no only, and a dismissal cancels it', async () => {
  for (const [answer, expected] of [['Yes', { confirmed: true }], ['No', { confirmed: false }], [undefined, { cancelled: true }]]) {
    const { bridge, sent, asked, idle } = harness({ answers: async () => (answer ? { 'ui-1': answer } : {}) });
    bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Confirm', message: 'Continue?' });
    await idle();
    assert.deepEqual(asked.answers[0].questions[0], {
      id: 'ui-1',
      question: 'Confirm\nContinue?',
      header: '',
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
      multiSelect: false,
      choiceOnly: true,
    });
    assert.deepEqual(sent, [{ type: 'extension_ui_response', id: 'ui-1', ...expected }]);
  }
});

test('input and editor are free-text questions; a secret input stays masked', async () => {
  const { bridge, sent, asked, idle } = harness({ answers: async (input) => ({ [input.questions[0].id]: 'typed' }) });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'input', title: 'API key', secret: true });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-2', method: 'editor', title: 'Notes' });
  await idle();
  assert.deepEqual(asked.answers.map((input) => input.questions[0]), [
    { id: 'ui-1', question: 'API key', header: '', options: [], multiSelect: false, isSecret: true },
    { id: 'ui-2', question: 'Notes', header: '', options: [], multiSelect: false },
  ]);
  assert.deepEqual(sent, [
    { type: 'extension_ui_response', id: 'ui-1', value: 'typed' },
    { type: 'extension_ui_response', id: 'ui-2', value: 'typed' },
  ]);
});

test('dialogs open one at a time, in request order', async () => {
  const release = [];
  const { bridge, asked, idle } = harness({
    answers: (input) => new Promise((resolveAnswer) => {
      release.push(() => resolveAnswer({ [input.questions[0].id]: 'A' }));
    }),
  });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'First', options: ['A'] });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Second', options: ['A'] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked.answers.map((input) => input.questions[0].question), ['First']);
  release.shift()();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked.answers.map((input) => input.questions[0].question), ['First', 'Second']);
  release.shift()();
  await idle();
});

test('an answer to a request OMP withdrew is not sent', async () => {
  let answer;
  const { bridge, sent, idle } = harness({ answers: () => new Promise((resolveAnswer) => { answer = resolveAnswer; }) });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A'], timeout: 10 });
  await new Promise((r) => setImmediate(r));
  bridge.handle({ type: 'extension_ui_request', id: 'ui-9', method: 'cancel', targetId: 'ui-1' });
  answer({ 'ui-1': 'A' });
  await idle();
  assert.deepEqual(sent, []);
});

test('presentation requests expect no answer', async () => {
  const { bridge, sent, asked, idle } = harness();
  for (const method of ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text', 'open_url']) {
    bridge.handle({ type: 'extension_ui_request', id: `ui-${method}`, method, message: 'x' });
  }
  await idle();
  assert.deepEqual(sent, []);
  assert.deepEqual(asked, { permission: [], answers: [] });
});

test('a request withdrawn while another dialog is open is never asked', async () => {
  let answerFirst;
  const { bridge, sent, asked, idle } = harness({
    answers: (input) => (input.questions[0].id === 'ui-1'
      ? new Promise((resolveAnswer) => { answerFirst = resolveAnswer; })
      : Promise.resolve({ 'ui-2': 'A' })),
  });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'First', options: ['A'] });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Second', options: ['A'] });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-9', method: 'cancel', targetId: 'ui-2' });
  await new Promise((r) => setImmediate(r));
  answerFirst({ 'ui-1': 'A' });
  await idle();
  assert.deepEqual(asked.answers.map((input) => input.questions[0].question), ['First']);
  assert.deepEqual(sent, [{ type: 'extension_ui_response', id: 'ui-1', value: 'A' }]);
});

test('a checkbox group is asked once, as a multi-select question', async () => {
  const { request, asked } = harness({ answers: answering(['Altura', 'Fuente']) });
  const result = await ompCheckboxQuestion(request, { title: '¿Qué cambiar?', labels: ['Altura', 'Ancho', 'Fuente'] });

  assert.deepEqual(result, { checked: ['Altura', 'Fuente'], typed: undefined });
  // OMP's own "Other" and "Done" rows are not options: the dialog has a text box and a submit button.
  assert.deepEqual(asked.answers.map((input) => input.questions), [[{
    id: 'req-1',
    question: '¿Qué cambiar?',
    header: '',
    options: [
      { label: 'Altura', description: '' },
      { label: 'Ancho', description: '' },
      { label: 'Fuente', description: '' },
    ],
    multiSelect: true,
    required: false,
  }]]);
});

test('options the form preselects open checked, and OMP still holds them while the user decides', async () => {
  const held = new Set(['Ancho', 'Fuente']);
  let heldWhileAsking;
  const { request, asked } = harness({
    answers: answering(() => {
      heldWhileAsking = [...held];
      return ['Altura', 'Fuente'];
    }),
  });
  const result = await ompCheckboxQuestion(request, { title: 'Pick', labels: ['Altura', 'Ancho', 'Fuente'], held });

  assert.deepEqual(asked.answers.map((input) => input.questions[0].options), [[
    { label: 'Altura', description: '' },
    { label: 'Ancho', description: '', selected: true },
    { label: 'Fuente', description: '', selected: true },
  ]]);
  // A timeout on OMP's side submits what it holds, which must be the form's own selection.
  assert.deepEqual(heldWhileAsking, ['Ancho', 'Fuente']);
  assert.deepEqual(result, { checked: ['Altura', 'Fuente'], typed: undefined });
});

test('text typed into a checkbox question is added through OMP\'s "Other" row', async () => {
  const { request, asked } = harness({ answers: answering(['Altura', 'Color']) });
  const result = await ompCheckboxQuestion(request, { title: 'Pick', labels: ['Altura', 'Ancho'] });
  assert.deepEqual(result, { checked: ['Altura'], typed: 'Color' });
  // The text was typed in the dialog; OMP's follow-up `input` request must not ask again.
  assert.equal(asked.answers.length, 1);
});

test('submitting nothing ends an optional group empty; dismissing the dialog cancels it', async () => {
  const submitted = harness({ answers: answering([]) });
  assert.deepEqual(
    await ompCheckboxQuestion(submitted.request, { title: 'Pick', labels: ['A', 'B'], held: new Set(['B']) }),
    { checked: [], typed: undefined },
  );

  const dismissed = harness({ answers: answering(undefined) });
  assert.equal(await ompCheckboxQuestion(dismissed.request, { title: 'Pick', labels: ['A', 'B'] }), undefined);
});

test('a group that needs an answer shows its first pick checked and takes more', async () => {
  // Until something is selected OMP sends such a group like a single choice.
  const { request, asked } = harness({ answers: answering('Ancho', ['Ancho', 'Fuente']) });
  const result = await ompCheckboxQuestion(request, {
    title: 'Pick',
    labels: ['Altura', 'Ancho', 'Fuente'],
    required: true,
  });

  assert.deepEqual(result, { checked: ['Ancho', 'Fuente'], typed: undefined });
  assert.deepEqual(asked.answers.map((input) => input.questions[0].multiSelect), [false, true]);
  assert.deepEqual(asked.answers[1].questions[0].options, [
    { label: 'Altura', description: '' },
    { label: 'Ancho', description: '', selected: true },
    { label: 'Fuente', description: '' },
  ]);
});

test('omp 18.12 rows (Done before "Other", none until a pick) still end in one multi-select', async () => {
  const { request, asked } = harness({ answers: answering('Go', ['Go', 'Zig']) });
  const result = await ompCheckboxQuestion(request, {
    title: 'Which languages?',
    labels: ['Go', 'Rust', 'Zig'],
    doneBeforeOther: true,
  });

  assert.deepEqual(result, { checked: ['Go', 'Zig'], typed: undefined });
  assert.deepEqual(asked.answers.map((input) => input.questions[0].multiSelect), [false, true]);
  assert.deepEqual(asked.answers[1].questions[0].options.map((option) => option.label), ['Go', 'Rust', 'Zig']);
});

test('omp 18.12 rows take typed text and an emptied selection like the newer ones', async () => {
  const typed = harness({ answers: answering('Go', ['Go', 'Odin']) });
  assert.deepEqual(
    await ompCheckboxQuestion(typed.request, { title: 'Pick', labels: ['Go', 'Rust'], doneBeforeOther: true }),
    { checked: ['Go'], typed: 'Odin' },
  );

  // Nothing selected leaves no "Done" row, so the question comes back until it has an answer.
  const emptied = harness({ answers: answering('Go', [], ['Rust']) });
  assert.deepEqual(
    await ompCheckboxQuestion(emptied.request, { title: 'Pick', labels: ['Go', 'Rust'], doneBeforeOther: true }),
    { checked: ['Rust'], typed: undefined },
  );
  assert.deepEqual(emptied.asked.answers.map((input) => input.questions[0].required), [undefined, false, true]);
});

test('an option that reads like the closing row is still an option', async () => {
  const labels = ['Keep going', 'Done selecting'];
  const { request, asked } = harness({ answers: answering(['Done selecting']) });
  const result = await ompCheckboxQuestion(request, { title: 'Pick', labels });

  assert.deepEqual(result, { checked: ['Done selecting'], typed: undefined });
  assert.deepEqual(asked.answers[0].questions[0].options.map((option) => option.label), labels);
});

test('a checkbox group without OMP\'s "Other" row takes no typed answer', async () => {
  const { request, asked } = harness({ answers: answering(['A']) });
  const response = await request({ method: 'select', title: 'Pick', options: ['A', 'B', DONE] });
  assert.equal(response.value, 'A');
  assert.equal(asked.answers[0].questions[0].choiceOnly, true);
});

test('clearing a group that needs an answer asks again and insists on one', async () => {
  const { request, asked } = harness({ answers: answering('A', [], ['B']) });
  const result = await ompCheckboxQuestion(request, { title: 'Pick', labels: ['A', 'B'], required: true });

  assert.deepEqual(result, { checked: ['B'], typed: undefined });
  assert.deepEqual(
    asked.answers.slice(1).map((input) => ({
      required: input.questions[0].required,
      selected: input.questions[0].options.filter((option) => option.selected).map((option) => option.label),
    })),
    [{ required: false, selected: ['A'] }, { required: true, selected: [] }],
  );
});

test('text already typed for a group stays unless new text replaces it', async () => {
  // The first, single-choice round is answered with text, so OMP holds an "Other" answer and no label.
  const kept = harness({ answers: answering('Color', ['A']) });
  assert.deepEqual(
    await ompCheckboxQuestion(kept.request, { title: 'Pick', labels: ['A', 'B'], required: true }),
    { checked: ['A'], typed: 'Color' },
  );
  assert.deepEqual(kept.asked.answers[1].questions[0].options.filter((option) => option.selected), []);

  const replaced = harness({ answers: answering('Color', ['A', 'Borde']) });
  assert.deepEqual(
    await ompCheckboxQuestion(replaced.request, { title: 'Pick', labels: ['A', 'B'], required: true }),
    { checked: ['A'], typed: 'Borde' },
  );
});

test('rounds whose count does not follow the toggles are shown as ordinary selects', async () => {
  const { request, asked } = harness({ answers: answering('B') });
  const round = { method: 'select', title: '(1 selected) Pick', options: ['A', 'B', DONE] };
  // The bridge toggles an option to learn which one is checked; this sender does not count it.
  await request(round);
  const response = await request(round);

  assert.equal(response.value, 'B');
  assert.deepEqual(asked.answers.map((input) => input.questions[0]), [{
    id: 'req-2',
    question: '(1 selected) Pick',
    header: '',
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: DONE, description: '' }],
    multiSelect: false,
    choiceOnly: true,
  }]);
});

test('an answer that comes after OMP withdrew a checkbox question is not replayed into the next one', async () => {
  let answerFirst;
  const replies = [
    () => new Promise((resolveAnswer) => { answerFirst = resolveAnswer; }),
    (question) => ({ [question.id]: ['B'] }),
  ];
  const { bridge, sent, idle, request } = harness({ answers: (input) => replies.shift()(input.questions[0]) });
  bridge.handle({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A', 'B', DONE] });
  await new Promise((r) => setImmediate(r));
  bridge.handle({ type: 'extension_ui_request', id: 'ui-9', method: 'cancel', targetId: 'ui-1' });
  answerFirst({ 'ui-1': ['A', 'B'] });
  await idle();
  assert.deepEqual(sent, []);

  // The same question again starts from its own dialog, not from the choice made too late.
  assert.deepEqual(
    await ompCheckboxQuestion(request, { title: 'Pick', labels: ['A', 'B'] }),
    { checked: ['B'], typed: undefined },
  );
});
