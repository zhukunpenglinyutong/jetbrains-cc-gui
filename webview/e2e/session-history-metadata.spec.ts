import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

test('native Codex history restores metadata and deletes without crossing providers', async ({ context, page }, testInfo) => {
  const resources = path.resolve(process.cwd(), '../src/main/resources');
  const html = await readFile(path.join(resources, 'html/claude-chat.html'), 'utf8');
  await context.route('https://cc-gui-webview.local/assets/**', async (route) => {
    const fileName = path.posix.basename(new URL(route.request().url()).pathname);
    const compressed = fileName.endsWith('.js') || fileName.endsWith('.css');
    const stored = await readFile(path.join(resources, 'webview/assets', compressed ? `${fileName}.gz` : fileName));
    await route.fulfill({ body: compressed ? gunzipSync(stored) : stored,
      contentType: fileName.endsWith('.js') ? 'text/javascript' : fileName.endsWith('.css') ? 'text/css' : 'application/octet-stream',
      headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await context.route('**/history-metadata', (route) => route.fulfill({ body: html, contentType: 'text/html' }));
  await context.addInitScript((version) => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('language', 'en');
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'codex', codexModel: 'gpt-5.4' }));
    if (localStorage.getItem('fixture-custom-title') === null) localStorage.setItem('fixture-custom-title', 'Previously saved name');
    if (localStorage.getItem('fixture-favorite') === null) localStorage.setItem('fixture-favorite', 'true');
    window.sendToJava = (message) => {
      const split = message.indexOf(':');
      const type = message.slice(0, split);
      if (type === 'update_title') {
        localStorage.setItem('fixture-custom-title', JSON.parse(message.slice(split + 1)).customTitle);
      }
      if (type === 'toggle_favorite') {
        localStorage.setItem('fixture-favorite', String(localStorage.getItem('fixture-favorite') !== 'true'));
      }
      if (type === 'codex_native_list_threads') {
        const request = JSON.parse(message.slice(split + 1));
        setTimeout(() => window.onCodexNativeData?.(JSON.stringify({ requestType: type, requestId: request.requestId,
          nextCursor: null, data: [
            { id: 'ordinary', name: 'Unfavorited native name', isFavorited: false, messageCount: 1 },
            { id: 'saved', name: 'Native prompt that must not replace the custom name',
              customTitle: localStorage.getItem('fixture-custom-title'), hasCustomTitle: true,
              isFavorited: localStorage.getItem('fixture-favorite') === 'true', favoritedAt: 123, messageCount: 2 },
          ] })), 0);
      }
      if (type === 'delete_session') {
        const request = JSON.parse(message.slice(split + 1));
        localStorage.setItem('fixture-delete-request', JSON.stringify(request));
        setTimeout(() => window.setHistoryData?.({ success: true, provider: 'claude',
          sessions: [{ sessionId: 'foreign', provider: 'claude', title: 'Wrong provider history' }] }), 0);
        setTimeout(() => window.setHistoryData?.({ success: true, provider: 'codex', sessions: [
          { sessionId: 'saved', provider: 'codex', title: localStorage.getItem('fixture-custom-title') ?? '',
            isFavorited: false, messageCount: 2 },
        ] }), 20);
      }
      if (type === 'get_dependency_status') {
        setTimeout(() => {
          const callback = (window as unknown as Record<string, unknown>).updateDependencyStatus;
          if (typeof callback === 'function') callback(JSON.stringify({
            'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
            'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
          }));
        }, 0);
      }
    };
  }, APP_VERSION);
  const openHistory = async () => {
    await expect(page.locator('.input-editable')).toBeVisible();
    await page.locator('.header button:has(.codicon-history)').click();
    await expect(page.locator('.history-item')).toHaveCount(2);
  };
  await page.goto('/history-metadata');
  await openHistory();
  const saved = page.locator('.history-item').filter({ hasText: 'Previously saved name' });
  await expect(saved.locator('.history-favorite-btn.favorited')).toBeVisible();
  await expect(page.locator('.history-item').first()).toContainText('Previously saved name');
  await saved.hover();
  await saved.locator('.history-edit-btn').click();
  await page.locator('.history-title-input').fill('Renamed and persisted');
  await page.locator('.history-title-input').press('Enter');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('fixture-custom-title'))).toBe('Renamed and persisted');
  await page.reload();
  await openHistory();
  const renamed = page.locator('.history-item').filter({ hasText: 'Renamed and persisted' });
  await expect(renamed.locator('.history-favorite-btn.favorited')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('restored-history-metadata.png') });
  await renamed.locator('.history-favorite-btn').click();
  await page.reload();
  await openHistory();
  await expect(page.locator('.history-item').filter({ hasText: 'Renamed and persisted' })
    .locator('.history-favorite-btn')).not.toHaveClass(/favorited/);
  const ordinary = page.locator('.history-item').filter({ hasText: 'Unfavorited native name' });
  await ordinary.hover();
  await ordinary.locator('.history-delete-btn').click();
  await page.locator('.modal-btn-danger').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fixture-delete-request') ?? '{}')))
    .toEqual({ sessionId: 'ordinary', provider: 'codex' });
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.locator('.history-item')).toContainText('Renamed and persisted');
  await expect(page.getByText('Wrong provider history')).toHaveCount(0);

});
