import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeExecutionScope, currentExecutionScope, withExecutionScope } from './execution-scope.js';

const makeScope = () => `${randomUUID()}/${randomUUID()}`;

test('scope accepts only an opaque binding/turn pair', () => {
  const scope = makeScope();
  assert.equal(normalizeExecutionScope(scope), scope);
  for (const value of [null, {}, '/private/project/path', 'PRIVATE_PROMPT', `${scope}/extra`]) {
    assert.equal(normalizeExecutionScope(value), '');
  }
});

test('file exchange supports a symbolic temporary root', () => {
  const temporaryRoot = realpathSync(tmpdir());
  const fixture = mkdtempSync(join(temporaryRoot, 'ccgui-scope-linked-'));
  try {
    const physical = join(fixture, 'physical');
    const alias = join(fixture, 'alias');
    mkdirSync(physical);
    symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const env = { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^real permission/question/plan', fileURLToPath(import.meta.url)], {
      env,
      timeout: 20_000,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    assert.match(output, /# tests 1\r?\n/);
    assert.match(output, /# pass 1\r?\n/);
  } finally {
    assert.equal(dirname(resolve(fixture)), temporaryRoot);
    assert.ok(basename(fixture).startsWith('ccgui-scope-linked-'));
    assert.equal(realpathSync(fixture), resolve(fixture));
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('parallel asynchronous dialogs retain separate captured scopes', async () => {
  const first = makeScope();
  const second = makeScope();
  const values = await Promise.all([first, second].map(scope => withExecutionScope(scope, async () => {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1));
    return currentExecutionScope();
  })));
  assert.deepEqual(values, [first, second]);
  assert.equal(currentExecutionScope(), '');
});

test('an explicitly unowned inter-turn callback suppresses an inherited old scope', async () => {
  await withExecutionScope(makeScope(), async () => {
    assert.notEqual(currentExecutionScope(), '');
    await withExecutionScope(undefined, async () => assert.equal(currentExecutionScope(), ''));
    assert.notEqual(currentExecutionScope(), '');
  });
  assert.equal(currentExecutionScope(), '');
});

test('real permission/question/plan file exchange carries correlation without changing decisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ccgui-office-scope-'));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      import { withExecutionScope } from './utils/execution-scope.js';
      import { requestAskUserQuestionAnswers, requestPermissionFromJava, requestPlanApproval } from './permission-ipc.js';
      const directory = process.env.CLAUDE_PERMISSION_DIR;
      const scope = process.env.CCGUI_TEST_EXECUTION_SCOPE;
      const cases = [
        ['ask-user-question-', () => requestAskUserQuestionAnswers({ questions: [] }), { answers: { selected: 'ok' } }],
        ['request-', () => requestPermissionFromJava('Bash', { command: 'TEST_ONLY' }), { allow: false }],
        ['plan-approval-', () => requestPlanApproval({ plan: 'TEST_ONLY', allowedPrompts: [] }), { approved: false, targetMode: 'default' }]
      ];
      for (const [prefix, start, response] of cases) {
        const pending = withExecutionScope(scope, start);
        const filename = readdirSync(directory).find(name => name.startsWith(prefix) && !name.includes('-response-'));
        assert.ok(filename);
        const request = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
        assert.equal(request.executionScope, scope);
        unlinkSync(join(directory, filename));
        const responsePrefix = prefix === 'request-' ? 'response-' : prefix.replace(/-$/, '-response-');
        writeFileSync(join(directory, responsePrefix + process.env.CLAUDE_SESSION_ID + '-' + request.requestId + '.json'), JSON.stringify(response));
        const result = await pending;
        if (prefix === 'request-') assert.equal(result, false);
        if (prefix === 'plan-approval-') assert.equal(result.approved, false);
        if (prefix === 'ask-user-question-') assert.equal(result.selected, 'ok');
      }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, CLAUDE_PERMISSION_DIR: directory, CLAUDE_SESSION_ID: 'office-scope-test', CCGUI_TEST_EXECUTION_SCOPE: makeScope() },
      timeout: 10_000,
      stdio: 'pipe',
    });
  } finally {
    // Only the fresh directory owned by this test can be removed.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('ccgui-office-scope-'));
    assert.equal(realpathSync(directory).toLowerCase(), join(realpathSync(tmpdir()), basename(directory)).toLowerCase());
    rmSync(directory, { recursive: true, force: true });
  }
});
