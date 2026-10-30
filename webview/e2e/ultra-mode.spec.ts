import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

async function boot(page: Page, provider: 'claude' | 'codex') {
  await page.addInitScript(({ provider, version }) => {
    localStorage.setItem('language', 'en');
    localStorage.setItem('lastSeenChangelogVersion', version);
    if (!localStorage.getItem('model-selection-state')) localStorage.setItem('model-selection-state', JSON.stringify({
      provider, claudeModel: 'claude-opus-5', codexModel: 'gpt-6-astra', reasoningEffort: 'high', longContextEnabled: false,
    }));
    const bridge = window as unknown as Record<string, any>;
    bridge.__CCGUI_PAGE_CONTEXT_READY__ = true;
    bridge.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    bridge.__ultraMessages = [];
    bridge.sendToJava = (message: string) => {
      bridge.__ultraMessages.push(message);
      const respond = (callback: string, payload: unknown) => setTimeout(() => bridge[callback]?.(JSON.stringify(payload)), 0);
      if (message.startsWith('get_dependency_status:')) respond('updateDependencyStatus', {
        'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
        'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
      });
      if (message.startsWith('get_cli_models:claude')) respond('setCliModels', { provider: 'claude', success: true,
        models: [{ id: 'claude-opus-5', label: 'Claude Opus 5', supportedReasoningEfforts: ['low', 'medium', 'high', 'max'] }] });
      if (message.startsWith('codex_native_list_models:')) {
        const request = JSON.parse(message.slice('codex_native_list_models:'.length));
        setTimeout(() => window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
          requestType: 'codex_native_list_models', requestId: request.requestId, nextCursor: null,
          data: ['gpt-6-astra', 'gpt-6-luna'].map(model => ({ model, displayName: model,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', ...(model.endsWith('astra') ? ['ultra'] : [])]
              .map(reasoningEffort => ({ reasoningEffort })) })),
        } })), 0);
      }
      if (message.startsWith('send_message:')) setTimeout(() => bridge.updateLoadingStatus?.(false), 0);
    };
  }, { provider, version: APP_VERSION });
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', provider);
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
}

async function latestSend(page: Page) {
  return page.evaluate(() => {
    const lines = (window as any).__ultraMessages as string[];
    const message = lines.filter(line => line.startsWith('send_message:')).at(-1);
    return message ? JSON.parse(message.slice('send_message:'.length)) : null;
  });
}

test('Codex Ultra is selected, sent and restored, and disappears for an unsupported model', async ({ page }) => {
  await boot(page, 'codex');
  const trigger = page.getByTestId('model-config-trigger');
  await trigger.click();
  await page.getByTestId('model-config-option-effort').click();
  await page.getByTestId('reasoning-selector-dropdown').getByText('Ultra', { exact: true }).click();
  await expect(trigger).toContainText('Ultra');
  await page.locator('.input-editable').fill('Review independent modules');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(async () => (await latestSend(page))?.reasoningEffort).toBe('ultra');
  await page.reload();
  await expect(trigger).toContainText('Ultra');
  await trigger.click();
  await page.getByTestId('model-option-gpt-6-luna').click();
  await expect(trigger).not.toContainText('Ultra');
  await page.getByTestId('model-config-option-effort').click();
  await expect(page.getByTestId('reasoning-selector-dropdown').getByText('Ultra', { exact: true })).toHaveCount(0);
  await page.getByTestId('reasoning-selector-dropdown').getByText('High', { exact: true }).click();
  await page.locator('.input-editable').fill('A lighter followup');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(async () => (await latestSend(page))?.reasoningEffort).toBe('high');
});

test('Claude Ultracode preserves effort and native background work stays visible and stoppable after the answer', async ({ page }, testInfo) => {
  await boot(page, 'claude');
  const trigger = page.getByTestId('model-config-trigger');
  await trigger.click();
  await page.getByTestId('model-config-option-effort').click();
  await page.getByTestId('reasoning-selector-dropdown').getByText('Low', { exact: true }).click();
  await trigger.click();
  await page.getByTestId('model-config-option-ultracode').click();
  await trigger.click();
  await expect(trigger).toContainText('Ultracode');
  await page.locator('.input-editable').fill('Review with native workflows');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(async () => {
    const send = await latestSend(page);
    return [send?.reasoningEffort, send?.claudeUltracode];
  }).toEqual(['low', true]);
  await page.reload();
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await expect(trigger).toContainText('Ultracode');
  await page.evaluate(() => {
    window.setSessionId?.('ultra-claude-session');
    window.onTaskEvent?.(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', session_id: 'ultra-claude-session',
      tasks: Array.from({ length: 80 }, (_, index) => ({ task_id: `workflow-${index}`, task_type: 'local_workflow', description: `Review module ${index}` })) }));
    window.updateLoadingStatus?.(false);
  });
  const panel = page.locator('.claude-background-tasks');
  await expect(panel).toContainText('80 background tasks running');
  await panel.locator('summary').click();
  await expect(panel.locator('li')).toHaveCount(80);
  await expect(page.locator('.submit-button:not(.stop-button)')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ultracode-background.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: 'Stop background tasks' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__ultraMessages.some((line: string) => line.startsWith('interrupt_session:')))).toBe(true);
  await expect(panel).toBeVisible();
  await page.evaluate(() => window.onTaskEvent?.(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed',
    session_id: 'ultra-claude-session', tasks: [] })));
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await page.getByTestId('model-config-option-ultracode').click();
  await trigger.click();
  await page.locator('.input-editable').fill('Continue without Ultracode');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(async () => {
    const send = await latestSend(page);
    return [send?.reasoningEffort, send?.claudeUltracode];
  }).toEqual(['low', false]);
});

test('a new tab without an explicit effort inherits the last-used Max preference', async ({ page }) => {
  await page.addInitScript(() => {
    window.__INITIAL_TAB_REASONING_EFFORT__ = null;
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex', codexModel: 'gpt-6-astra', reasoningEffort: 'max',
    }));
  });
  await boot(page, 'codex');
  await expect(page.getByTestId('model-config-trigger')).toContainText('Max');
  await page.locator('.input-editable').fill('Use my last effort preference');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(async () => (await latestSend(page))?.reasoningEffort).toBe('max');
});

test('a restored Ultra preference resolves for a custom model absent from the loaded catalog', async ({ page }) => {
  await page.addInitScript(() => {
    window.__INITIAL_TAB_REASONING_EFFORT__ = 'ultra';
    localStorage.setItem('codex-custom-models', JSON.stringify([{ id: 'custom-codex', label: 'Custom Codex' }]));
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex', codexModel: 'custom-codex', reasoningEffort: 'ultra',
    }));
  });
  await boot(page, 'codex');
  const trigger = page.getByTestId('model-config-trigger');
  await expect(trigger).toContainText('Custom Codex');
  await expect(trigger).toContainText('High');
  await expect(trigger).not.toContainText('Ultra');
  await page.locator('.input-editable').fill('Send with a supported fallback effort');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(async () => (await latestSend(page))?.reasoningEffort).toBe('high');
});
