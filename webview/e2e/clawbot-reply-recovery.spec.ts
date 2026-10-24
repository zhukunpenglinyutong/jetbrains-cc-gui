import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((version) => {
    localStorage.setItem('language', 'zh');
    localStorage.setItem('lastSeenChangelogVersion', version);
    const bridge = window as Window & typeof globalThis & {
      sendToJava?: (message: string) => void;
      onClawBotStatus?: (json: string) => void;
      onClawBotOperation?: (json: string) => void;
      recoveryRequests?: string[];
    };
    bridge.recoveryRequests = [];
    let retried = false;
    const status = { state: 'LEADER', transport: 'ILINK', sessionCount: 1, bindingState: 'BOUND', bindingRevision: 1 };
    bridge.sendToJava = (message) => {
      bridge.recoveryRequests?.push(message);
      if (message.startsWith('get_clawbot_status:')) {
        setTimeout(() => bridge.onClawBotStatus?.(JSON.stringify(status)), 0);
      }
      if (message.startsWith('clawbot_list_reply_recovery:') || message.startsWith('clawbot_retry_reply:')) {
        const operation = message.startsWith('clawbot_retry_reply:') ? 'retry_reply' : 'list_reply_recovery';
        if (operation === 'retry_reply') retried = true;
        setTimeout(() => bridge.onClawBotOperation?.(JSON.stringify({ operation, ok: true,
          replyRecoveryAvailable: true, replyRecoveryBindingRevision: 1,
          replyRecoveryItems: [{ eventId: '00000000-0000-4000-8000-000000000001', status: 'UNKNOWN',
            updatedAt: Date.now(), expiresAt: Date.now() + 86_400_000, kind: 'FINAL_REPLY',
            reason: retried ? 'RETRY_STARTED' : 'READY', retryStatus: retried ? 'SENT' : '' }],
        })), 0);
      }
    };
  }, APP_VERSION);
  await page.goto('/');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('微信 Claw Bot', { exact: true }).locator('..').click();
  await page.getByRole('button', { name: '加载最近结果', exact: true }).click();
  await expect(page.getByRole('button', { name: '重发已保存回复', exact: true })).toBeEnabled();
});

test('cancel and confirm recovery without overflowing the viewport', async ({ page }) => {
  const retry = page.getByRole('button', { name: '重发已保存回复', exact: true });
  await retry.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('不会重新执行 AI 任务');
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await dialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { recoveryRequests: string[] }).recoveryRequests
    .filter((value) => value.startsWith('clawbot_retry_reply:')))).toEqual([]);
  await retry.click();
  await dialog.getByRole('button', { name: '确认重发', exact: true }).click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByText('恢复投递状态: 已发送', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { recoveryRequests: string[] }).recoveryRequests
    .filter((value) => value.startsWith('clawbot_retry_reply:')))).toEqual([
    'clawbot_retry_reply:{"eventId":"00000000-0000-4000-8000-000000000001","bindingRevision":1,"confirmed":true}',
  ]);
});

test('binding change closes confirmation and disables the stale answer', async ({ page }) => {
  await page.getByRole('button', { name: '重发已保存回复', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => {
    const callback = (window as unknown as { onClawBotStatus: (json: string) => void }).onClawBotStatus;
    callback(JSON.stringify({ state: 'LEADER', transport: 'ILINK', sessionCount: 1, bindingState: 'BOUND', bindingRevision: 2 }));
  });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '重发已保存回复', exact: true })).toBeDisabled();
});
