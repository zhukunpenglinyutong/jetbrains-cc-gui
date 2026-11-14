import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type PackagedWindow = Window & typeof globalThis & {
  __packagedBridgeEvents: string[];
  sendToJava: (message: string) => void;
};

// Test both the shared cache and the network fallback using the packaged resources.
const testPackagedTabs = (cacheMode: 'enabled' | 'unavailable' | 'write-denied') => test(`packaged chat tabs preserve input and lazy imports with cache ${cacheMode}`, async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'JCEF resource startup is a desktop flow');
  const resources = path.resolve(process.cwd(), '../src/main/resources');
  const assets = path.join(resources, 'webview/assets');
  const html = await readFile(path.join(resources, 'html/claude-chat.html'), 'utf8');
  expect(Buffer.byteLength(html)).toBeLessThan(32_768);
  const errors: string[] = [];
  const loadedAssets: string[] = [];
  const startupMs: number[] = [];
  let entryRequested!: () => void;
  const entryRequest = new Promise<void>((resolve) => { entryRequested = resolve; });
  let stylesheetReleased = false;
  let entryOverlappedStylesheet = false;

  // Mirror JCEF's binary resource handler: modules and styles are stored as
  // gzip and decompressed by Java before reaching Chromium at their stable URL.
  await context.route('https://cc-gui-webview.local/assets/**', async (route) => {
    const fileName = path.posix.basename(new URL(route.request().url()).pathname);
    if (/^index-.*\.js\.gz$/.test(fileName)) {
      entryOverlappedStylesheet ||= !stylesheetReleased;
      entryRequested();
    }
    if (/^index-.*\.css$/.test(fileName)) {
      // A deferred module waits for CSS; holding CSS reveals that startup waterfall.
      await Promise.race([entryRequest, new Promise((resolve) => setTimeout(resolve, 1500))]);
      stylesheetReleased = true;
    }
    const compressed = fileName.endsWith('.js') || fileName.endsWith('.css');
    const stored = await readFile(path.join(assets, compressed ? `${fileName}.gz` : fileName));
    const body = compressed ? gunzipSync(stored) : stored;
    const mimeType = fileName.endsWith('.js') ? 'text/javascript'
      : fileName.endsWith('.css') ? 'text/css'
      : fileName.endsWith('.woff2') ? 'font/woff2'
      : fileName.endsWith('.ttf') ? 'font/truetype'
      : 'application/octet-stream';
    loadedAssets.push(fileName);
    await route.fulfill({
      status: 200,
      body,
      contentType: mimeType,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  await context.route('**/packaged-webview', (route) => route.fulfill({
    contentType: 'text/html',
    body: html,
  }));
  await context.addInitScript(({ version, cacheMode }) => {
    if (cacheMode === 'unavailable') {
      Object.defineProperty(window, 'caches', {
        value: { open: () => Promise.reject(new DOMException('Storage denied', 'SecurityError')) },
      });
    } else if (cacheMode === 'write-denied') {
      const open = caches.open.bind(caches);
      caches.open = async (name) => {
        const cache = await open(name);
        cache.put = () => Promise.reject(new DOMException('Storage full', 'QuotaExceededError'));
        return cache;
      };
    }
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude', claudeModel: 'claude-sonnet-4-6', claudePermissionMode: 'bypassPermissions',
    }));
    const bridge = window as PackagedWindow;
    bridge.__packagedBridgeEvents = [];
    localStorage.setItem('language', 'en');
    bridge.sendToJava = (message) => {
      bridge.__packagedBridgeEvents.push(message);
      if (message.startsWith('tt_ensure_server:') || message.startsWith('tt_proxy:')) {
        const request = JSON.parse(message.slice(message.indexOf(':') + 1));
        const data = message.startsWith('tt_ensure_server:')
          ? { running: true, port: 7680 }
          : { body: JSON.stringify({ data: [], totals: {}, projects: [], token: 'fixture' }) };
        setTimeout(() => window.onTokenTrackerResponse?.(JSON.stringify({
          requestId: request.requestId, ok: true, data,
        })), 0);
      }
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => {
          const callback = (window as unknown as Record<string, unknown>).updateDependencyStatus;
          if (typeof callback === 'function') {
            callback(JSON.stringify({
              'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
              'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
            }));
          }
        }, 0);
      }
    };
  }, { version: APP_VERSION, cacheMode });

  if (cacheMode === 'enabled') {
    // Cached code is untrusted until checked against the bundled digest, even if its URL matches.
    const urls = [html.match(/https:\/\/cc-gui-webview\.local\/assets\/index-[\w-]+\.js\.gz/)![0],
      html.match(/https:\/\/cc-gui-webview\.local\/assets\/index-[\w-]+\.css/)![0]];
    await context.route('**/cache-seed', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    const seed = await context.newPage();
    await seed.goto('/cache-seed');
    await seed.evaluate(async (urls) => {
      const cache = await caches.open('ccgui-webview-startup-v1');
      for (const url of urls) await cache.put(url, new Response('invalid cached resource'));
    }, urls);
    await seed.close();
    // Simultaneous cold restores should share one download before subsequent tabs reuse it.
    const coldTabs = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all(coldTabs.map(async (page) => {
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/packaged-webview');
      await expect.poll(() => page.evaluate(() => (window as PackagedWindow).__packagedBridgeEvents
        .some((event) => event.startsWith('frontend_ready:')))).toBe(true);
      await page.close();
    }));
  }

  for (let tab = 0; tab < 2; tab++) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const started = Date.now();
    await page.goto('/packaged-webview');
    await expect(page).toHaveTitle('Claude Chat Webview');
    await expect.poll(() => page.evaluate(() => (window as PackagedWindow).__packagedBridgeEvents
      .some((event) => event.startsWith('frontend_ready:'))), { timeout: 15_000 }).toBe(true);
    const input = page.locator('.input-editable');
    await expect(input).toBeVisible();
    await expect(page.locator('.sdk-warning-bar')).toHaveCount(0);
    startupMs.push(Date.now() - started);

    if (tab === 1) {
      const mermaidFile = (await readdir(assets)).find((name) => /^mermaid\.core-.*\.js\.gz$/.test(name));
      expect(mermaidFile).toBeTruthy();
      const diagram = await page.evaluate(async (url) => {
        const module = await import(url);
        // Rollup can expose the package namespace under a generated named export.
        const candidates = Object.values(module).flatMap((value) => value
          && typeof value === 'object' && 'default' in value ? [value, value.default] : [value]);
        const mermaid = candidates.find((value) => value && typeof value === 'object'
          && 'initialize' in value && 'render' in value) as {
          initialize: (config: object) => void;
          render: (id: string, source: string) => Promise<{ svg: string }>;
        };
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        return (await mermaid.render('packaged-assets-smoke', 'graph TD; A-->B;')).svg;
      }, `https://cc-gui-webview.local/assets/${mermaidFile!.slice(0, -3)}`);
      expect(diagram).toContain('<svg');
    }
    await input.fill(`packaged tab ${tab + 1}`);
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as PackagedWindow).__packagedBridgeEvents
      .filter((event) => event.startsWith('send_message:')))).toHaveLength(1);
    await expect(input).toBeEmpty();

    if (tab === 1) {
      // This lazy chunk imports React from the entry module. Reopening it must
      // reuse the running app rather than evaluate a second entry/React copy.
      for (let visit = 0; visit < 2; visit++) {
        await page.locator('.header button:has(.codicon-settings-gear)').click();
        await page.locator('.codicon-graph').click();
        await expect(page.locator('.tt-dashboard')).toBeVisible();
        await expect(page.locator('.tt-dashboard')).toContainText('Daily Breakdown');
        await expect(page.locator('.tt-dashboard').getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
        await expect.poll(() => page.evaluate(() => (window as PackagedWindow).__packagedBridgeEvents
          .filter((event) => event.startsWith('frontend_ready:')).length)).toBe(1);
        if (visit === 0) {
          await page.screenshot({ path: testInfo.outputPath('packaged-usage.png') });
        }
        await page.locator('button:has(.codicon-arrow-left)').click();
        await expect(input).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath('packaged-chat.png') });
    }
    await page.close();
  }

  expect(loadedAssets.some((name) => /^index-.*\.js\.gz$/.test(name))).toBe(true);
  expect(entryOverlappedStylesheet, 'entry fetching must start before CSS finishes').toBe(true);
  expect(loadedAssets.filter((name) => /^index-.*\.js\.gz$/.test(name)))
    .toHaveLength(cacheMode === 'enabled' ? 1 : 2);
  expect(loadedAssets.filter((name) => /^index-.*\.css$/.test(name)))
    .toHaveLength(cacheMode === 'enabled' ? 1 : 2);
  expect(loadedAssets.some((name) => /^flowDiagram-.*\.js$/.test(name))).toBe(true);
  expect(errors).toEqual([]);
  await testInfo.attach('startup-metrics', {
    body: Buffer.from(JSON.stringify({ startupMs, loadedAssets }, null, 2)),
    contentType: 'application/json',
  });
});

testPackagedTabs('enabled');
testPackagedTabs('unavailable');
testPackagedTabs('write-denied');
