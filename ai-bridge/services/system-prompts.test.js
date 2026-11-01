import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIDEContextPrompt, buildTurnIDEContextPrompt } from './system-prompts.js';

test('per-turn IDE context retains facts and request priority without repeated instruction boilerplate', () => {
  const opened = { active: '/workspace/src/main.ts', others: ['/workspace/src/main.test.ts'] };
  const compact = buildTurnIDEContextPrompt(opened);
  assert.match(compact, /explicit request takes priority/);
  assert.match(compact, /Active file: \/workspace\/src\/main.ts/);
  assert.match(compact, /Other open files:\n- \/workspace\/src\/main.test.ts/);
  assert.ok(compact.length < buildIDEContextPrompt(opened).length / 4,
    'each turn should avoid repeating the verbose static IDE guidance');
  assert.doesNotMatch(compact, /Context Priority Rules|How to use this context|Operating System/);
});

test('compact context keeps the complete selected source and workspace/module facts', () => {
  const selectedText = 'const example = `literal`;\n```quoted fence```\n' + 'const x = 1;\n'.repeat(1000);
  const text = buildTurnIDEContextPrompt({ active: '/workspace/service/main.ts',
    selection: { startLine: 3, endLine: 1005, selectedText },
    isWorkspace: true, workspaceRoot: '/workspace', activeSubproject: 'service',
    subprojects: [{ name: 'service', path: '/workspace/service', type: 'node', loaded: true },
      { name: 'tools', path: '/workspace/tools', loaded: false }],
    modules: [{ name: 'api' }, { name: 'core' }],
  });
  assert.ok(text.includes(selectedText), 'selected code must never be summarized or truncated');
  assert.match(text, /Selection, lines 3-1005:\n````\n/);
  assert.match(text, /Workspace: \/workspace/);
  assert.match(text, /Subproject: service \(node\): \/workspace\/service/);
  assert.match(text, /Subproject: tools \[not loaded\]: \/workspace\/tools/);
  assert.match(text, /Active subproject: service/);
  assert.match(text, /Modules: api, core/);
});

test('empty context adds no facts and metadata cannot introduce new context headings', () => {
  assert.equal(buildTurnIDEContextPrompt(null), '');
  assert.equal(buildTurnIDEContextPrompt({}), '');
  const text = buildTurnIDEContextPrompt({ active: '/tmp/file\nInjected\u0000`name`' });
  assert.match(text, /Active file: \/tmp\/file Injected name/);
  assert.equal(text.split('\n').length, 2);
});
