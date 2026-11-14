import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

const injectCompressedModuleBootstrap = async (html) => {
  const moduleScriptPattern = /<script type="module" crossorigin src="([^"]+)"><\/script>/;
  const match = html.match(moduleScriptPattern);
  if (!match) {
    throw new Error('Unable to find the Vite entry module');
  }

  const compressedModuleUrl = `${match[1]}.gz`;
  const stylesheetPattern = /<link rel="stylesheet" crossorigin href="([^"]+)">/g;
  const stylesheetUrls = [...html.matchAll(stylesheetPattern)].map((stylesheet) => stylesheet[1]);
  const digests = Object.fromEntries(await Promise.all([compressedModuleUrl, ...stylesheetUrls].map(async (url) => {
    const fileName = path.posix.basename(new URL(url).pathname);
    const bytes = await readFile(path.join(fileName.endsWith('.gz') ? targetAssetsDir : distAssetsDir, fileName));
    return [url, createHash('sha256').update(bytes).digest('hex')];
  })));
  // A classic inline script starts fetching before CSS can block deferred module execution.
  const bootstrap = `<script>
      (async () => {
        const domReady = document.readyState === 'loading'
          ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
          : Promise.resolve();
        const digests = ${JSON.stringify(digests)};
        let cache;
        try {
          cache = await caches.open('ccgui-webview-startup-v1');
        } catch {
          // IDE/browser policies can deny storage; the network path must remain usable.
        }
        const loadAsset = async (url) => {
          const load = async () => {
            try {
              const cached = await cache?.match(url);
              if (cached) {
                // File-backed JCEF pages share storage. Verify bytes before reusing executable assets.
                const hash = await crypto.subtle.digest('SHA-256', await cached.clone().arrayBuffer());
                const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
                if (digest === digests[url]) return cached;
                await cache.delete(url);
              }
            } catch {}
            const response = await fetch(url);
            if (!response.ok) throw new Error(\`Failed to load webview asset: \${response.status}\`);
            try {
              await cache?.put(url, response.clone());
            } catch {}
            return response;
          };
          // Restored tabs may start together. Recheck the shared cache after acquiring the lock.
          if (cache && navigator.locks) {
            let acquired = false;
            try {
              return await navigator.locks.request('ccgui-webview:' + url, () => {
                acquired = true;
                return load();
              });
            } catch (error) {
              if (acquired) throw error;
            }
          }
          return load();
        };
        const [[response, ...stylesheets]] = await Promise.all([
          Promise.all([${JSON.stringify(compressedModuleUrl)}, ...${JSON.stringify(stylesheetUrls)}].map(loadAsset)),
          domReady,
        ]);
        if (!response.ok || !response.body) {
          throw new Error(\`Failed to load compressed webview module: \${response.status}\`);
        }
        const sourceStream = response.body.pipeThrough(new DecompressionStream('gzip'));
        const [source, ...styles] = await Promise.all([
          new Response(sourceStream).text(),
          ...stylesheets.map((stylesheet) => stylesheet.text()),
        ]);
        for (const [index, css] of styles.entries()) {
          // Vite's lazy-import preloader checks stylesheet links by URL. Keep a disabled
          // marker so it does not download CSS again after we apply its cached text.
          const marker = document.createElement('link');
          marker.rel = 'stylesheet';
          marker.disabled = true;
          marker.href = ${JSON.stringify(stylesheetUrls)}[index];
          document.head.appendChild(marker);
          const style = document.createElement('style');
          style.textContent = css;
          document.head.appendChild(style);
        }
        const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try {
          // Lazy chunks import the canonical entry URL. Remap it to this blob so the
          // entry (and its React instance) keeps a single module identity instead of
          // being evaluated a second time under the canonical URL.
          const importMap = document.createElement('script');
          importMap.type = 'importmap';
          importMap.textContent = JSON.stringify({ imports: { [${JSON.stringify(match[1])}]: objectUrl } });
          document.head.appendChild(importMap);
          await import(objectUrl);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
        // Bound storage across upgrades; only this plugin's startup resources use this cache.
        if (cache) {
          cache.keys().then((keys) => Promise.all(keys.slice(0, -8).map((key) => cache.delete(key))))
            .catch(() => {});
        }
      })().catch(async (error) => {
        console.error('[CC GUI] Webview bootstrap failed', error);
        if (!document.body) {
          await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }
        // A blank chat tab is indistinguishable from a slow one; surface the failure.
        const fallback = document.createElement('p');
        fallback.style.cssText = 'padding:16px;font-family:sans-serif';
        fallback.textContent = '聊天界面资源加载失败，请关闭此标签页后重试。';
        document.body.appendChild(fallback);
      });
    </script>`;
  return html.replace(stylesheetPattern, '').replace(moduleScriptPattern, bootstrap);
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
  // Remote JCEF transfers handler responses over the Gateway channel. Keeping
  // hashed chunks compressed and cacheable avoids resending a 9 MB HTML blob
  // for every restored or newly-created chat tab.
  await rm(targetAssetsDir, { recursive: true, force: true });
  await mkdir(targetAssetsDir, { recursive: true });
  const assets = await readdir(distAssetsDir);
  await Promise.all(assets.map(copyAsset));
  const html = await injectCompressedModuleBootstrap(await readFile(distFile, 'utf-8'));
  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, html, 'utf-8');

  console.log(`[copy-dist] Copied HTML and ${assets.length} assets`);
};

main().catch((error) => {
  console.error('[copy-dist] 复制构建产物失败', error);
  process.exit(1);
});
