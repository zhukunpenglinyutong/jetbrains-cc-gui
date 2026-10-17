import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { init, parse } from 'es-module-lexer';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback, constants as zlibConstants } from 'node:zlib';

const cwd = process.cwd();
const webviewAssetOrigin = 'https://cc-gui-webview.local';
const distFile = path.resolve(cwd, 'dist/index.html');
const targetFile = path.resolve(cwd, '../src/main/resources/html/claude-chat.html');
const distAssetsDir = path.resolve(cwd, 'dist/assets');
const targetAssetsDir = path.resolve(cwd, '../src/main/resources/webview/assets');
const gzip = promisify(gzipCallback);

const rewriteRelativeModuleImports = async (source) => {
  await init;
  const [imports] = parse(source);
  const relativeImports = imports
    .filter(({ n }) => n?.startsWith('./'))
    .sort((left, right) => right.s - left.s);

  let rewritten = source;
  for (const moduleImport of relativeImports) {
    const absoluteUrl = new URL(moduleImport.n, `${webviewAssetOrigin}/assets/`).href;
    const originalSpecifier = source.slice(moduleImport.s, moduleImport.e);
    // Static and dynamic import ranges differ in whether they include the surrounding quotes.
    const replacement = originalSpecifier.startsWith('"') || originalSpecifier.startsWith("'")
      ? JSON.stringify(absoluteUrl)
      : absoluteUrl;
    rewritten = `${rewritten.slice(0, moduleImport.s)}${replacement}${rewritten.slice(moduleImport.e)}`;
  }
  parse(rewritten);
  return rewritten;
};

const injectCompressedModuleBootstrap = (html) => {
  const moduleScriptPattern = /<script type="module" crossorigin src="([^"]+)"><\/script>/;
  const match = html.match(moduleScriptPattern);
  if (!match) {
    throw new Error('Unable to find the Vite entry module');
  }

  const compressedModuleUrl = `${match[1]}.gz`;
  const bootstrap = `<script type="module">
      (async () => {
        const response = await fetch(${JSON.stringify(compressedModuleUrl)});
        if (!response.ok || !response.body) {
          throw new Error(\`Failed to load compressed webview module: \${response.status}\`);
        }
        const sourceStream = response.body.pipeThrough(new DecompressionStream('gzip'));
        const source = await new Response(sourceStream).text();
        const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try {
          await import(objectUrl);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      })().catch((error) => console.error('[CC GUI] Webview bootstrap failed', error));
    </script>`;
  return html.replace(moduleScriptPattern, bootstrap);
};

const copyAsset = async (fileName) => {
  const source = path.join(distAssetsDir, fileName);
  const target = path.join(targetAssetsDir, fileName);
  if (fileName.endsWith('.js')) {
    const rewritten = await rewriteRelativeModuleImports(await readFile(source, 'utf-8'));
    const compressed = await gzip(Buffer.from(rewritten), {
      level: zlibConstants.Z_BEST_COMPRESSION,
    });
    await writeFile(`${target}.gz`, compressed);
    return;
  }
  if (fileName.endsWith('.css')) {
    const compressed = await gzip(await readFile(source), {
      level: zlibConstants.Z_BEST_COMPRESSION,
    });
    await writeFile(`${target}.gz`, compressed);
    return;
  }
  await copyFile(source, target);
};

const main = async () => {
  const html = injectCompressedModuleBootstrap(await readFile(distFile, 'utf-8'));
  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, html, 'utf-8');

  // Remote JCEF transfers handler responses over the Gateway channel. Keeping
  // hashed chunks compressed and cacheable avoids resending a 9 MB HTML blob
  // for every restored or newly-created chat tab.
  await rm(targetAssetsDir, { recursive: true, force: true });
  await mkdir(targetAssetsDir, { recursive: true });
  const assets = await readdir(distAssetsDir);
  await Promise.all(assets.map(copyAsset));

  console.log(`[copy-dist] Copied HTML and ${assets.length} assets`);
};

main().catch((error) => {
  console.error('[copy-dist] 复制构建产物失败', error);
  process.exit(1);
});
