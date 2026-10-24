import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type HistoryWindow = Window & {
  historyActivity: 'running' | 'waiting' | 'failed' | 'idle';
  historyRequests: string[];
};

for (const [label, currentSessionId] of [['current tab', 'history-activity-target'], ['other tab', 'history-observer'], ['blank tab', null]] as const) {
test(`a fetched running history unlocks from ${label} without reopening or rescanning history`, async ({ page }) => {
  await page.addInitScript(({ version, currentSessionId }) => {
    localStorage.setItem('language', 'zh');
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'codex', codexModel: 'gpt-6.1' }));
    if (currentSessionId) window.__pendingSessionId = currentSessionId;
    const bridge = window as HistoryWindow;
    bridge.historyActivity = 'running';
    bridge.historyRequests = [];
    window.sendToJava = message => {
      bridge.historyRequests.push(message);
      const separator = message.indexOf(':');
      const action = message.slice(0, separator);
      if (action === 'get_dependency_status') setTimeout(() => window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
        'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
      })), 0);
      if (action === 'codex_native_list_threads') {
        const request = JSON.parse(message.slice(separator + 1)) as { requestId: string };
        setTimeout(() => window.onCodexNativeData?.(JSON.stringify({ requestType: action, requestId: request.requestId,
          data: [{ id: 'history-activity-target', name: 'Finishing history', status: { type: 'active' }, messageCount: 3 }],
        })), 0);
      }
      if (action === 'get_ai_storage_mutation_status') {
        const request = JSON.parse(message.slice(separator + 1)) as { requestId: string };
        const idle = bridge.historyActivity === 'idle';
        const response = bridge.historyActivity === 'failed' ? { success: false, error: 'DATABASE_BUSY' } : {
          success: true, data: { available: idle, ...(idle ? {} : { unavailableReason: 'SESSION_RUNNING' }),
            deletionAvailable: true, runningSessionIds: idle ? [] : ['history-activity-target'],
            writerSessionIds: currentSessionId === 'history-activity-target' ? [] : ['history-activity-target'] },
        };
        setTimeout(() => window.onCodexStorageResponse?.(JSON.stringify({ action, requestId: request.requestId, ...response })), 0);
      }
    };
  }, { version: APP_VERSION, currentSessionId });
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.evaluate(() => { window.onStreamStart?.(); window.showLoading?.('true'); });
  await page.locator('.codicon-history').click();
  await expect(page.getByText('Finishing history', { exact: true })).toBeVisible();
  const remove = page.locator('.history-delete-btn');
  await expect(remove).toBeDisabled();

  // The UI finishes first; an owned pending question must retain protection.
  const activityRequests = () => page.evaluate(() => (window as HistoryWindow).historyRequests
    .filter(message => message.startsWith('get_ai_storage_mutation_status:')).length);
  let previous = await activityRequests();
  await page.evaluate(() => {
    (window as HistoryWindow).historyActivity = 'waiting';
    window.onStreamEnd?.(); window.showLoading?.('false');
  });
  await expect.poll(activityRequests).toBeGreaterThan(previous);
  await expect(remove).toBeDisabled();

  previous = await activityRequests();
  await page.evaluate(() => { (window as HistoryWindow).historyActivity = 'failed'; });
  await expect.poll(activityRequests).toBeGreaterThan(previous);
  await expect(remove).toBeDisabled();

  await page.evaluate(() => { (window as HistoryWindow).historyActivity = 'idle'; });
  await expect(remove).toBeEnabled();
  await page.getByRole('button', { name: '多选', exact: true }).click();
  await expect(page.getByRole('checkbox').last()).toBeEnabled();
  const lists = await page.evaluate(() => (window as HistoryWindow).historyRequests
    .filter(message => message.startsWith('codex_native_list_threads:')));
  expect(lists).toHaveLength(1);
});
}
