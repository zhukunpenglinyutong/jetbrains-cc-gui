import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type PackagedWindow = Window & typeof globalThis & {
  __packagedBridgeEvents: string[];
  sendToJava: (message: string) => void;
};

// Test the packaged resources rather than Vite's development module transport.
test('packaged chat tabs bootstrap compressed assets and preserve input and lazy imports', async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'JCEF resource startup is a desktop flow');
  const resources = path.resolve(process.cwd(), '../src/main/resources');
  const assets = path.join(resources, 'webview/assets');
  const html = await readFile(path.join(resources, 'html/claude-chat.html'), 'utf8');
  expect(Buffer.byteLength(html)).toBeLessThan(32_768);
  const errors: string[] = [];
  const loadedAssets: string[] = [];
  const startupMs: number[] = [];

  // Mirror JCEF's binary resource handler: .gz is fetched as-is, while lazy modules
  // and styles are decompressed by Java before reaching Chromium.
  await context.route('https://cc-gui-webview.local/assets/**', async (route) => {
    const fileName = path.posix.basename(new URL(route.request().url()).pathname);
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
  await context.addInitScript((version) => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude', claudeModel: 'claude-sonnet-4-6', claudePermissionMode: 'bypassPermissions',
    }));
    const bridge = window as PackagedWindow;
    bridge.__packagedBridgeEvents = [];
    bridge.sendToJava = (message) => {
      bridge.__packagedBridgeEvents.push(message);
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
  }, APP_VERSION);

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
      await page.screenshot({ path: testInfo.outputPath('packaged-chat.png') });
    }
    await page.close();
  }

  expect(loadedAssets.some((name) => /^index-.*\.js\.gz$/.test(name))).toBe(true);
  expect(loadedAssets.some((name) => /^flowDiagram-.*\.js$/.test(name))).toBe(true);
  expect(errors).toEqual([]);
  await testInfo.attach('startup-metrics', {
    body: Buffer.from(JSON.stringify({ startupMs, loadedAssets }, null, 2)),
    contentType: 'application/json',
  });
});
