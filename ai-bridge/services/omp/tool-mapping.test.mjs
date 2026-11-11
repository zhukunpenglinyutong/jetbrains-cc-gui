import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  absolutePath,
  isPlainFilePath,
  mapCompletedTool,
  mapStartedTool,
  parseNumberedDiff,
} from './tool-mapping.js';

const CWD = resolve('/work/project');
const HOME = resolve('/home/tester');

function ok(text, details) {
  return { text, details, isError: false };
}

test('parseNumberedDiff splits regions at empty lines and keeps blank file lines', () => {
  const diff = [
    ' 148|            yield return null;',
    '-149|            yield return new WaitForEndOfFrame();',
    '+149|            yield return null;',
    ' 150|',
    '',
    ' 226|        }',
    '-227|        /// old',
    '+227|        /// new',
    '+228|        /// added',
  ].join('\n');
  assert.deepEqual(parseNumberedDiff(diff), [
    {
      old_string: '            yield return null;\n            yield return new WaitForEndOfFrame();\n',
      new_string: '            yield return null;\n            yield return null;\n',
    },
    {
      old_string: '        }\n        /// old',
      new_string: '        }\n        /// new\n        /// added',
    },
  ]);
});

test('parseNumberedDiff accepts unpadded line numbers and text containing pipes', () => {
  assert.deepEqual(parseNumberedDiff(' 8|a | b\n-9|x|y\n+9|x|z'), [
    { old_string: 'a | b\nx|y', new_string: 'a | b\nx|z' },
  ]);
});

test('parseNumberedDiff starts a new region where the line numbers jump', () => {
  // omp prints hunks back to back when it leaves out the unchanged lines between them.
  const diff = [
    ' 3|keep',
    '-4|old',
    '+4|new',
    ' 5|keep',
    ' 28|far',
    '-29|old2',
    '+29|new2',
    ' 30|end',
  ].join('\n');
  assert.deepEqual(parseNumberedDiff(diff), [
    { old_string: 'keep\nold\nkeep', new_string: 'keep\nnew\nkeep' },
    { old_string: 'far\nold2\nend', new_string: 'far\nnew2\nend' },
  ]);
  // Added lines alone: their numbers are those of the new file.
  assert.deepEqual(parseNumberedDiff('+5|a\n+6|b\n+50|c'), [
    { old_string: '', new_string: 'a\nb' },
    { old_string: '', new_string: 'c' },
  ]);
});

test('parseNumberedDiff drops regions that only hold context', () => {
  assert.deepEqual(parseNumberedDiff(' 1|same\n 2|same too\n\n-5|gone'), [
    { old_string: 'gone', new_string: '' },
  ]);
});

test('parseNumberedDiff never joins lines across something that is not a diff line', () => {
  // An elision marker or note between two changes must not weld them into one region.
  assert.deepEqual(parseNumberedDiff('-1|a\n+1|b\n... 40 unchanged lines ...\n-50|c\n+50|d'), [
    { old_string: 'a', new_string: 'b' },
    { old_string: 'c', new_string: 'd' },
  ]);
});

test('parseNumberedDiff reads a diff with CRLF line breaks', () => {
  assert.deepEqual(parseNumberedDiff(' 1|keep\r\n-2|old\r\n+2|new\r\n\r\n-9|x\r\n+9|y'), [
    { old_string: 'keep\nold', new_string: 'keep\nnew' },
    { old_string: 'x', new_string: 'y' },
  ]);
});

test('todo becomes TodoWrite with every open and finished task of every phase', () => {
  const mapped = mapCompletedTool(
    { id: 'call-1', name: 'todo', args: { op: 'done', task: 'Map' }, cwd: CWD },
    ok('Remaining items (2)', {
      op: 'done',
      phases: [
        { name: 'Research', tasks: [{ content: 'Map', status: 'completed' }, { content: 'Dropped', status: 'abandoned' }] },
        { name: 'Build', tasks: [{ content: 'Wire', status: 'in_progress' }, { content: 'Ship', status: 'blocked', blocker: 'CI' }] },
      ],
    }),
  );
  assert.deepEqual(mapped.uses, [{
    id: 'call-1',
    name: 'TodoWrite',
    input: {
      todos: [
        { content: 'Map', status: 'completed', activeForm: 'Map' },
        { content: 'Wire', status: 'in_progress', activeForm: 'Wire' },
        { content: 'Ship', status: 'pending', activeForm: 'Ship' },
      ],
    },
  }]);
  assert.deepEqual(mapped.results, [{ toolUseId: 'call-1', content: 'Remaining items (2)', isError: false }]);
});

test('a cleared todo list still maps, so the panel empties', () => {
  const mapped = mapCompletedTool({ id: 'c', name: 'todo', args: { op: 'rm' } }, ok('Todo list cleared.', { phases: [] }));
  assert.deepEqual(mapped.uses, [{ id: 'c', name: 'TodoWrite', input: { todos: [] } }]);
});

test('a failed todo call stays a todo call', () => {
  const args = { op: 'start', task: 'Missing' };
  const mapped = mapCompletedTool(
    { id: 'c', name: 'todo', args },
    { text: 'Errors: Task "Missing" not found', details: { phases: [] }, isError: true },
  );
  assert.deepEqual(mapped.uses, [{ id: 'c', name: 'todo', input: args }]);
  assert.deepEqual(mapped.results, [{ toolUseId: 'c', content: 'Errors: Task "Missing" not found', isError: true }]);
});

test('edit becomes one Edit block per changed region, numbered across files', () => {
  const mapped = mapCompletedTool(
    { id: 'toolu_1', name: 'edit', args: { input: '[a.cs#1A2B]\nPUT 9.=9:\n+x' }, cwd: CWD },
    ok('[a.cs#3C4D]', {
      diff: 'ignored aggregate',
      firstChangedLine: 9,
      perFileResults: [
        { path: '/abs/a.cs', diff: '-9|old a\n+9|new a\n\n-20|old b\n+20|new b', op: 'update' },
        { path: '/abs/b.cs', diff: ' 1|keep\n+2|inserted', op: 'update' },
      ],
    }),
  );
  assert.deepEqual(mapped.uses, [
    { id: 'toolu_1', name: 'Edit', input: { file_path: '/abs/a.cs', old_string: 'old a', new_string: 'new a' } },
    { id: 'toolu_1#2', name: 'Edit', input: { file_path: '/abs/a.cs', old_string: 'old b', new_string: 'new b' } },
    { id: 'toolu_1#3', name: 'Edit', input: { file_path: '/abs/b.cs', old_string: 'keep', new_string: 'keep\ninserted' } },
  ]);
  assert.deepEqual(mapped.results, [
    { toolUseId: 'toolu_1', content: '[a.cs#3C4D]', isError: false },
    { toolUseId: 'toolu_1#2', content: '', isError: false },
    { toolUseId: 'toolu_1#3', content: '', isError: false },
  ]);
});

test('a single-file edit reads path and diff from the details themselves', () => {
  const mapped = mapCompletedTool(
    { id: 'e', name: 'edit', args: { input: '[x#0000]' } },
    ok('done', { diff: '-3|a\n+3|b', firstChangedLine: 3, op: 'update', path: '/abs/x.ts', snapshotsPruned: true }),
  );
  assert.deepEqual(mapped.uses, [
    { id: 'e', name: 'Edit', input: { file_path: '/abs/x.ts', old_string: 'a', new_string: 'b' } },
  ]);
});

test('an edit that cannot be shown as a diff keeps its call and gains the file path', () => {
  const patch = '*** Begin Patch\n[src/app.ts#1A2B]\nPUT 4.=4:\n+const value = 2;\n*** End Patch';
  const failed = mapCompletedTool(
    { id: 'e', name: 'edit', args: { input: patch } },
    { text: 'stale tag', details: { diff: '', errorKind: 'stale_tag' }, isError: true },
  );
  assert.deepEqual(failed.uses, [{ id: 'e', name: 'edit', input: { input: patch, file_path: 'src/app.ts' } }]);
  assert.deepEqual(failed.results, [{ toolUseId: 'e', content: 'stale tag', isError: true }]);

  // Replace mode names the file in `path`; a result without regions falls back the same way.
  const noRegions = mapCompletedTool(
    { id: 'e2', name: 'edit', args: { path: 'lib/a.py', old_string: 'x', new_string: 'x' } },
    ok('no change', {}),
  );
  assert.equal(noRegions.uses[0].name, 'edit');
  assert.equal(noRegions.uses[0].input.file_path, 'lib/a.py');

  // Entries of perFileResults without path and diff do not count as files.
  const malformed = mapCompletedTool(
    { id: 'e3', name: 'edit', args: { input: 'no header' } },
    ok('?', { perFileResults: [{ path: '/abs/a' }, null] }),
  );
  assert.deepEqual(malformed.uses, [{ id: 'e3', name: 'edit', input: { input: 'no header' } }]);
});

test('write to a file becomes Write with an absolute path', () => {
  const call = { id: 'w', name: 'write', args: { path: 'docs/notes.md', content: '# Notes\n' }, cwd: CWD, home: HOME };
  assert.deepEqual(mapStartedTool(call), [
    { id: 'w', name: 'Write', input: { file_path: resolve(CWD, 'docs/notes.md'), content: '# Notes\n' } },
  ]);
  // Once the result is known, OMP's resolved path wins.
  const done = mapCompletedTool(call, ok('Successfully wrote 8 bytes', { resolvedPath: '/real/docs/notes.md' }));
  assert.deepEqual(done.uses, [
    { id: 'w', name: 'Write', input: { file_path: '/real/docs/notes.md', content: '# Notes\n' } },
  ]);
  assert.deepEqual(done.results, [{ toolUseId: 'w', content: 'Successfully wrote 8 bytes', isError: false }]);
});

test('write to a path omp rewrites waits for its result', () => {
  const call = { id: 'w', name: 'write', args: { path: '@/tmp/other/out.txt', content: 'hi' }, cwd: CWD, home: HOME };
  assert.equal(mapStartedTool(call), null);
  const done = mapCompletedTool(call, ok('Successfully wrote 2 bytes', { resolvedPath: '/tmp/other/out.txt' }));
  assert.deepEqual(done.uses, [
    { id: 'w', name: 'Write', input: { file_path: '/tmp/other/out.txt', content: 'hi' } },
  ]);
  // Without a resolved path (the call failed or was cut short) the call is shown as it was made.
  const failed = mapCompletedTool(call, { text: 'denied', details: {}, isError: true });
  assert.deepEqual(failed.uses, [{ id: 'w', name: 'write', input: call.args }]);
  assert.deepEqual(mapCompletedTool(call).uses, [{ id: 'w', name: 'write', input: call.args }]);
});

test('isPlainFilePath accepts only paths omp writes to exactly as written', () => {
  for (const path of ['notes.md', 'src/a.ts', '/abs/a.ts', '~', '~/a', 'C:\\a\\b.txt']) {
    assert.equal(isPlainFilePath(path), true, path);
  }
  for (const path of [
    '@/abs/a', ':./a', '~name', '[src/a.ts#1A2B]', 'bundle.zip:inner.txt', 'a\u00A0b', '/', '', ' a', 'xd://lsp', 5,
  ]) {
    assert.equal(isPlainFilePath(path), false, String(path));
  }
  assert.equal(isPlainFilePath('/c/a', 'win32'), false);
  assert.equal(isPlainFilePath('/c/a', 'linux'), true);
});

test('write to a URL or device is not a file write', () => {
  for (const path of ['local://plan.md', 'xd://lsp', 'proc://bg_1/kill']) {
    const args = { path, content: '{}' };
    assert.deepEqual(mapStartedTool({ id: 'w', name: 'write', args, cwd: CWD }), [{ id: 'w', name: 'write', input: args }], path);
  }
});

test('absolutePath expands home and resolves relative paths against the session cwd', () => {
  assert.equal(absolutePath('~', CWD, HOME), HOME);
  assert.equal(absolutePath('~/notes/a.md', CWD, HOME), resolve(HOME, 'notes/a.md'));
  assert.equal(absolutePath('src/a.ts', CWD, HOME), resolve(CWD, 'src/a.ts'));
  assert.equal(absolutePath(resolve('/etc/hosts'), CWD, HOME), resolve('/etc/hosts'));
});

test('task becomes one Task block per subagent', () => {
  const call = {
    id: 'toolu_t',
    name: 'task',
    args: {
      context: '# Goal',
      tasks: [
        { name: 'AuditCoreLoop', agent: 'scout', task: '# Target\nSlice B', solutionSpace: 'open' },
        { id: 'legacy-2', assignment: 'Do the thing' },
        'not an object',
      ],
    },
  };
  const uses = [
    { id: 'toolu_t', name: 'Task', input: { description: 'AuditCoreLoop', prompt: '# Target\nSlice B', subagent_type: 'scout' } },
    { id: 'toolu_t#2', name: 'Task', input: { description: 'legacy-2', prompt: 'Do the thing', subagent_type: 'task' } },
    { id: 'toolu_t#3', name: 'Task', input: { description: 'Task 3', prompt: '', subagent_type: 'task' } },
  ];
  assert.deepEqual(mapStartedTool(call), uses);

  const done = mapCompletedTool(call, { text: 'Spawned 3 background agents', details: { async: true }, isError: true });
  assert.deepEqual(done.uses, uses);
  assert.deepEqual(done.results, [
    { toolUseId: 'toolu_t', content: 'Spawned 3 background agents', isError: true },
    { toolUseId: 'toolu_t#2', content: '', isError: true },
    { toolUseId: 'toolu_t#3', content: '', isError: true },
  ]);
});

test('calls that need their result are held back at start, others pass through unchanged', () => {
  assert.equal(mapStartedTool({ id: 't', name: 'todo', args: { op: 'view' } }), null);
  assert.equal(mapStartedTool({ id: 'e', name: 'edit', args: { input: '[a#0000]' } }), null);
  const args = { command: 'echo hi' };
  assert.deepEqual(mapStartedTool({ id: 'b', name: 'bash', args }), [{ id: 'b', name: 'bash', input: args }]);
  // A task call without a task list is not a subagent launch.
  assert.deepEqual(mapStartedTool({ id: 'x', name: 'task', args: { tasks: [] } }), [{ id: 'x', name: 'task', input: { tasks: [] } }]);
});

test('a call without a result yields its blocks and no results', () => {
  const pending = mapCompletedTool({ id: 'e', name: 'edit', args: { input: '[src/a.ts#1A2B]\nCUT 1.=1' } });
  assert.deepEqual(pending.uses, [{ id: 'e', name: 'edit', input: { input: '[src/a.ts#1A2B]\nCUT 1.=1', file_path: 'src/a.ts' } }]);
  assert.deepEqual(pending.results, []);
});
