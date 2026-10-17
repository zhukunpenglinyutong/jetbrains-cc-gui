import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { init, parse } from 'es-module-lexer';

const script = fileURLToPath(new URL('./copy-dist.mjs', import.meta.url));
const origin = 'https://cc-gui-webview.local';

// Exercise the real postbuild command in an isolated Vite output directory.
const fixture = async (t, html) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ccgui-webview-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'webview');
  const assets = path.join(cwd, 'dist/assets');
  const resources = path.join(root, 'src/main/resources');
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(cwd, 'dist/index.html'), html);
  return { cwd, assets, resources };
};

const html = `<!doctype html><html><head>
<script type="module" crossorigin src="${origin}/assets/index-entry.js"></script>
<link rel="stylesheet" crossorigin href="${origin}/assets/index-style.css">
</head><body><div id="app"></div></body></html>`;

test('packages a small bootstrap and lossless compressed assets with valid module imports', async (t) => {
  const { cwd, assets, resources } = await fixture(t, html);
  const source = [
    'import { shared } from "./shared-chunk.js";',
    "export { default as worker } from './worker-chunk.js';",
    "const load = () => import('./lazy-chunk.js');",
    'window.fixture = { shared, load, note: "欢迎 🚀" };',
    `/* ${'frontend bundle '.repeat(20_000)} */`,
  ].join('\n');
  const css = 'body { color: red; font-family: fixture; }';
  const font = Buffer.from([0, 1, 2, 128, 255]);
  await Promise.all([
    writeFile(path.join(assets, 'index-entry.js'), source),
    writeFile(path.join(assets, 'shared-chunk.js'), 'export const shared = 42;'),
    writeFile(path.join(assets, 'worker-chunk.js'), 'export default 7;'),
    writeFile(path.join(assets, 'lazy-chunk.js'), 'export default 9;'),
    writeFile(path.join(assets, 'index-style.css'), css),
    writeFile(path.join(assets, 'fixture-font.woff2'), font),
  ]);

  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const bootstrap = await readFile(path.join(resources, 'html/claude-chat.html'), 'utf8');
  assert.ok(Buffer.byteLength(bootstrap) < 32_768, 'per-tab HTML must not inline the bundle');
  assert.ok(bootstrap.includes(`${origin}/assets/index-entry.js.gz`));
  assert.ok(bootstrap.includes("DecompressionStream('gzip')"));
  assert.ok(bootstrap.includes('URL.revokeObjectURL(objectUrl)'));

  const packaged = path.join(resources, 'webview/assets');
  const compressed = await readFile(path.join(packaged, 'index-entry.js.gz'));
  assert.ok(compressed.length < Buffer.byteLength(source) / 4);
  const module = gunzipSync(compressed).toString('utf8');
  assert.ok(module.includes('欢迎 🚀'));
  await init;
  const [imports] = parse(module);
  assert.deepEqual(imports.map(({ n }) => n), [
    `${origin}/assets/shared-chunk.js`,
    `${origin}/assets/worker-chunk.js`,
    `${origin}/assets/lazy-chunk.js`,
  ]);
  assert.equal(gunzipSync(await readFile(path.join(packaged, 'index-style.css.gz'))).toString(), css);
  assert.deepEqual(await readFile(path.join(packaged, 'fixture-font.woff2')), font);
});

test('removes obsolete hashed assets when rebuilding', async (t) => {
  const { cwd, assets, resources } = await fixture(t, html);
  await writeFile(path.join(assets, 'index-entry.js'), 'export const current = true;');
  const packaged = path.join(resources, 'webview/assets');
  await mkdir(packaged, { recursive: true });
  await writeFile(path.join(packaged, 'obsolete-hash.js.gz'), 'stale');

  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(path.join(packaged, 'obsolete-hash.js.gz')), { code: 'ENOENT' });
  assert.equal(
    gunzipSync(await readFile(path.join(packaged, 'index-entry.js.gz'))).toString(),
    'export const current = true;',
  );
});

test('fails the build when the entry module is missing', async (t) => {
  const { cwd, resources } = await fixture(t, '<html><body>missing module</body></html>');
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(path.join(resources, 'html/claude-chat.html')), { code: 'ENOENT' });
});
