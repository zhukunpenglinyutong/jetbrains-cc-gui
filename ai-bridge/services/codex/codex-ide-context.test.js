import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { sniffForContextSupport, dressContextForTurn } from './codex-ide-context.js';

test('schema discovery uses the selected CLI and removes its temporary output', async () => {
  for (const supported of [true, false]) {
    let directory;
    const found = await sniffForContextSupport({ command: [process.execPath, 'codex.js'], cwd: process.cwd(), env: {} },
      async (file, args, options) => {
        assert.equal(file, process.execPath);
        assert.deepEqual(args.slice(0, 3), ['codex.js', 'app-server', 'generate-json-schema']);
        assert.ok(args.includes('--experimental'));
        assert.equal(options.timeout, 5000);
        directory = args[args.indexOf('--out') + 1];
        await mkdir(join(directory, 'v2'));
        await writeFile(join(directory, 'v2', 'TurnStartParams.json'), JSON.stringify({
          properties: supported ? { additionalContext: {} } : { input: {} },
        }));
      });
    assert.equal(found, supported);
    await assert.rejects(access(directory), { code: 'ENOENT' });
  }
});

test('unsupported schema commands and unreadable schemas select the legacy envelope', async () => {
  assert.equal(await sniffForContextSupport({ command: ['codex'] }, async () => { throw new Error('unknown argument'); }), false);
  assert.equal(await sniffForContextSupport({ command: ['codex'] }, async () => {}), false);
});

test('legacy wrapping retains media ordering and moves UTF-8 text element ranges', () => {
  const input = [{ type: 'localImage', path: '/shot.png' },
    { type: 'text', text: 'Ask $skill', text_elements: [{ byteRange: { start: 4, end: 10 }, placeholder: '$skill' }] }];
  const context = { ide_context: { kind: 'application', value: 'Active file: 中文.java' } };
  const result = dressContextForTurn(input, context, false);
  assert.deepEqual(result.input[0], input[0]);
  const wrapped = result.input[1];
  const prefixBytes = Buffer.byteLength(wrapped.text) - Buffer.byteLength(input[1].text);
  assert.deepEqual(wrapped.text_elements[0].byteRange, { start: 4 + prefixBytes, end: 10 + prefixBytes });
  assert.equal(input[1].text, 'Ask $skill');
  assert.deepEqual(input[1].text_elements[0].byteRange, { start: 4, end: 10 });
  assert.deepEqual(dressContextForTurn(input, context, true), { input, additionalContext: context });
});

test('legacy wrapping includes every context fragment before the original request', () => {
  const context = {
    ide_context: { kind: 'application', value: 'Active file: App.java' },
    open_tabs: { kind: 'application', value: 'Other tabs: Service.java' },
    referenced_files_0: { kind: 'application', value: 'Referenced file: Explicit.java' },
  };
  const { input } = dressContextForTurn([{ type: 'text', text: 'inspect the selected lines' }], context, false);
  assert.equal(input[0].text, '# Context from my IDE setup:\n\nActive file: App.java\n\nOther tabs: Service.java\n\n'
    + 'Referenced file: Explicit.java\n\n## My request for Codex:\ninspect the selected lines');
});

test('image-only and context-free turns retain their original payloads', () => {
  const input = [{ type: 'localImage', path: '/shot.png' }];
  assert.deepEqual(dressContextForTurn(input, {}, false), { input });
  const context = { ide_context: { kind: 'application', value: 'Active file: App.java' } };
  const result = dressContextForTurn(input, context, false);
  assert.equal(result.input[0].type, 'text');
  assert.match(result.input[0].text, /## My request for Codex:\n$/);
  assert.deepEqual(result.input[1], input[0]);
});
