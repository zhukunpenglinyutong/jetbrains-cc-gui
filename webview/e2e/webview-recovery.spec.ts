import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

const draftKey = 'recovery-e2e:project:original-tab';
const draftText = '重建后保留的草稿\n第二行内容';

async function setupPage(page: Page, key: string) {
  await page.addInitScript(({ key, version }) => {
    window.__CCGUI_DRAFT_CACHE_KEY__ = key;
    localStorage.setItem('language', 'en');
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude', claudeModel: 'claude-sonnet-4-6', claudePermissionMode: 'bypassPermissions',
    }));
    const target = window as Window & { __recoveryEvents: string[] };
    target.__recoveryEvents = [];
    window.sendToJava = (message: string) => {
      target.__recoveryEvents.push(message);
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => window.updateDependencyStatus?.(JSON.stringify({
          'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
          'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
        })), 0);
      }
    };
  }, { key, version: APP_VERSION });
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __recoveryEvents: string[] })
    .__recoveryEvents.some((message) => message.startsWith('frontend_ready:')))).toBe(true);
}

async function acknowledgeRecovery(page: Page) {
  await page.evaluate(() => window.prepareWebviewRecovery?.('native-recovery-e2e'));
  await expect.poll(() => page.evaluate(() => (window as Window & { __recoveryEvents: string[] })
    .__recoveryEvents.filter((message) => message.startsWith('webview_recovery_prepared:'))
    .map((message) => JSON.parse(message.slice(message.indexOf(':') + 1))).at(-1))).toEqual({
    requestId: 'native-recovery-e2e', success: true,
  });
}

async function replaceNativeDocument(context: BrowserContext, source: Page) {
  await source.close();
  const replacement = await context.newPage();
  await setupPage(replacement, draftKey);
  return replacement;
}

test('native browser replacement retains unsent text and images and leaves another tab untouched', async ({ context, page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'PC native-browser recovery');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  context.on('page', (created) => created.on('pageerror', (error) => errors.push(error.message)));
  await setupPage(page, draftKey);
  const other = await context.newPage();
  await setupPage(other, 'recovery-e2e:project:other-tab');
  await other.locator('.input-editable').fill('另外一个标签的草稿');
  await page.locator('.input-editable').fill(draftText);
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const drawing = canvas.getContext('2d')!;
    drawing.fillStyle = '#8d5ff2';
    drawing.fillRect(0, 0, 24, 24);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'recovery-fixture.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  await page.evaluate(() => sessionStorage.setItem('ccgui.dialog-draft.askUserQuestion.fixture-token',
    JSON.stringify({ dialogToken: 'fixture-token', answer: '未提交的回答' })));
  await acknowledgeRecovery(page);
  const replacement = await replaceNativeDocument(context, page);
  replacement.on('pageerror', (error) => errors.push(error.message));
  await expect(replacement.locator('.input-editable')).toHaveText(draftText, { useInnerText: true });
  await expect(replacement.locator('.attachment-item')).toHaveCount(1);
  expect(await replacement.evaluate(() => JSON.parse(sessionStorage
    .getItem('ccgui.dialog-draft.askUserQuestion.fixture-token')!).answer)).toBe('未提交的回答');
  await expect(other.locator('.input-editable')).toHaveText('另外一个标签的草稿');
  await expect(replacement.locator('.attachment-thumbnail')).toHaveAttribute('src', /data:image\/png;base64,/);
  await expect.poll(() => replacement.locator('.attachment-thumbnail')
    .evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await replacement.screenshot({ path: info.outputPath('recovered-view.png') });
  await replacement.locator('.header-right .icon-button').last().click();
  await expect(replacement.locator('.input-editable')).toHaveCount(0);
  await expect(replacement.locator('button:has(.codicon-arrow-left)').first()).toBeVisible();
  await replacement.locator('button:has(.codicon-arrow-left)').first().click();
  await expect(replacement.locator('.input-editable')).toHaveText(draftText, { useInnerText: true });
  expect(errors).toEqual([]);
});

test('checkpoint storage failure preserves the input and reports failure instead of replacing the browser', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'PC native-browser recovery');
  await setupPage(page, draftKey);
  await page.locator('.input-editable').fill(draftText);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('ccgui-browser-recovery:')) throw new DOMException('Full', 'QuotaExceededError');
      original.call(this, key, value);
    };
    window.prepareWebviewRecovery?.('native-recovery-e2e');
  });
  await expect.poll(() => page.evaluate(() => (window as Window & { __recoveryEvents: string[] })
    .__recoveryEvents.filter((message) => message.startsWith('webview_recovery_prepared:'))
    .map((message) => JSON.parse(message.slice(message.indexOf(':') + 1))).at(-1)?.success)).toBe(false);
  await expect(page.locator('.input-editable')).toHaveText(draftText, { useInnerText: true });
  await page.locator('.input-editable').press('End');
  await page.keyboard.type(' still editable');
  await expect(page.locator('.input-editable')).toContainText('still editable');
  expect(await page.evaluate(() => document.body.inert)).toBe(false);
});
