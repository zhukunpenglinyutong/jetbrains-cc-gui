import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';
import { projectCodexItemMessages } from '../../ai-bridge/services/codex/codex-item-projection.js';

type BootstrapWindow = Window & { __bootstrapMessages: string[] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(version => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'codex', codexModel: 'gpt-5.5' }));
    // The native ready replay can reach the placeholder before React registers its callback.
    window.__pendingSessionId = 'restored-root';
    const bridge = window as BootstrapWindow;
    bridge.__bootstrapMessages = [];
    window.sendToJava = message => {
      bridge.__bootstrapMessages.push(message);
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => window.updateDependencyStatus?.(JSON.stringify({
          'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
          'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
        })), 0);
      }
    };
  }, APP_VERSION);
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'codex');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
});

function nativeMessages(item: Record<string, unknown>, turnId: string) {
  return projectCodexItemMessages(item, { threadId: 'restored-root', turnId })
    .map(raw => ({ type: raw.type, content: raw.message?.content?.map((block: { text?: string }) => block.text ?? '').join('') ?? '',
      raw, timestamp: '2026-10-04T10:24:31Z' }));
}

async function startCompact(page: Page) {
  await page.locator('.input-editable').fill('/compact');
  await page.locator('.input-editable').press('Enter');
  await expect(page.locator('.stop-button')).toBeVisible();
  await expect(page.locator('.waiting-indicator')).toBeVisible();
  return page.evaluate(() => {
    const message = (window as BootstrapWindow).__bootstrapMessages.find(value => value.startsWith('codex_compact:'))!;
    return JSON.parse(message.slice('codex_compact:'.length)) as { threadId: string; requestId: string };
  });
}

test('restored compact waits for its terminal, then displays the next response', async ({ page }) => {
  const request = await startCompact(page);
  expect(request.threadId).toBe('restored-root');
  const boundary = nativeMessages({ type: 'contextCompaction', id: 'compact-boundary', status: 'completed' }, 'compact-turn');
  await page.evaluate(messages => window.updateMessages?.(JSON.stringify(messages)), boundary);
  await expect(page.locator('.stop-button')).toBeVisible();
  await page.evaluate(payload => window.onCodexInteractionResponse?.(JSON.stringify(payload)),
    { ...request, requestType: 'codex_compact', outcome: 'completed', success: true });
  await expect(page.locator('.stop-button')).toHaveCount(0);
  await expect(page.locator('.waiting-indicator')).toHaveCount(0);
  await page.locator('.input-editable').fill('Continue after compact');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as BootstrapWindow).__bootstrapMessages
    .filter(message => message.startsWith('send_message:')).length)).toBe(1);
  const reply = nativeMessages({ type: 'agentMessage', id: 'next-reply', text: 'Visible response after compact' }, 'next-turn');
  await page.evaluate(messages => {
    window.onStreamStart?.();
    window.updateMessages?.(JSON.stringify(messages));
    window.onStreamEnd?.();
    window.showLoading?.('false');
  }, [...boundary, ...reply]);
  await expect(page.getByText('Visible response after compact', { exact: true })).toBeVisible();
  await expect(page.locator('.stop-button')).toHaveCount(0);
});

test('Stop on a restored compact waits for the native interrupted result', async ({ page }) => {
  const request = await startCompact(page);
  expect(request.threadId).toBe('restored-root');
  await page.locator('.stop-button').click();
  await expect.poll(() => page.evaluate(() => (window as BootstrapWindow).__bootstrapMessages
    .filter(message => message === 'interrupt_session:').length)).toBe(1);
  await expect(page.locator('.stop-button')).toBeVisible();
  await page.evaluate(payload => window.onCodexInteractionResponse?.(JSON.stringify(payload)),
    { ...request, requestType: 'codex_compact', outcome: 'interrupted', success: false });
  await expect(page.locator('.stop-button')).toHaveCount(0);
  await expect(page.locator('.waiting-indicator')).toHaveCount(0);
  await page.locator('.input-editable').fill('Continue after Stop');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as BootstrapWindow).__bootstrapMessages
    .filter(message => message.startsWith('send_message:')).length)).toBe(1);
});
