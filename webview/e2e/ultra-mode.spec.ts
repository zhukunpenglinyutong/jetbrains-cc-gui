import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

async function boot(page: Page, provider: 'claude' | 'codex', deferCatalog = false) {
  await page.addInitScript(({ provider, version, deferCatalog }) => {
    localStorage.setItem('language', 'en');
    localStorage.setItem('lastSeenChangelogVersion', version);
    if (!localStorage.getItem('model-selection-state')) localStorage.setItem('model-selection-state', JSON.stringify({
      provider, claudeModel: 'claude-opus-5', codexModel: 'gpt-6-astra', reasoningEffort: 'high', longContextEnabled: false,
    }));
    const bridge = window as unknown as Record<string, any>;
    bridge.__CCGUI_PAGE_CONTEXT_READY__ = true;
    bridge.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    bridge.__ultraMessages = [];
    bridge.__deferUltraCatalog = deferCatalog;
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
        if (bridge.__deferUltraCatalog) return;
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
  }, { provider, version: APP_VERSION, deferCatalog });
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', provider);
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
}

async function latestSend(page: Page) {
  return page.evaluate(() => {
    const lines = (window as any).__ultraMessages as string[];
    const message = lines.filter(line => /^send_message(?:_with_attachments)?:/.test(line)).at(-1);
    return message ? JSON.parse(message.slice(message.indexOf(':') + 1)) : null;
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

async function attachImage(page: Page) {
  await page.locator('.input-editable').evaluate(input => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const data = canvas.toDataURL('image/png').split(',')[1];
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))],
      'review-context.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.attachment-item')).toHaveCount(1);
}

test('catalog timeout preserves Ultra and the attached draft until an explicit retry confirms support', async ({ page }) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => {
    window.__INITIAL_TAB_REASONING_EFFORT__ = 'ultra';
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex', codexModel: 'gpt-6-astra', reasoningEffort: 'ultra',
    }));
  });
  await boot(page, 'codex', true);
  const trigger = page.getByTestId('model-config-trigger');
  await expect(trigger).toContainText('Ultra');
  await page.locator('.input-editable').fill('Keep my requested mode and this image');
  await attachImage(page);
  await trigger.click();
  const retry = page.getByTestId('model-load-error');
  await expect(retry).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  await page.locator('.input-editable').press('Enter');
  await expect(page.locator('.input-editable')).toContainText('Keep my requested mode and this image');
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  expect(await latestSend(page)).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('model-selection-state') || '{}').reasoningEffort)).toBe('ultra');
  await page.evaluate(() => { (window as any).__deferUltraCatalog = false; });
  await trigger.click();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await trigger.click();
  await page.locator('.input-editable').press('Enter');
  await expect.poll(async () => (await latestSend(page))?.reasoningEffort).toBe('ultra');
  expect((await latestSend(page)).attachments).toHaveLength(1);
});

async function requestProviderChange(page: Page, provider: string): Promise<string> {
  const previousCount = await page.evaluate(() => ((window as any).__ultraMessages as string[])
    .filter(line => line.startsWith('create_new_session:')).length);
  await page.locator('.button-area-left .selector-button').nth(1).click();
  await page.locator(`[data-provider-id="${provider}"]`).click();
  const confirm = page.locator('.alert-dialog .confirm-button');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  let token = '';
  await expect.poll(async () => {
    const request = await page.evaluate(count => {
      const lines = ((window as any).__ultraMessages as string[]).filter(line => line.startsWith('create_new_session:'));
      return lines.length > count ? JSON.parse(lines.at(-1)!.slice('create_new_session:'.length)) : null;
    }, previousCount);
    token = request?.transitionToken ?? '';
    return request?.provider;
  }).toBe(provider);
  return token;
}

test('one legacy background task has Stop and a completion received on another provider stays cleared', async ({ page }) => {
  await boot(page, 'claude');
  await page.evaluate(() => {
    window.setSessionId?.('legacy-session');
    window.onTaskEvent?.(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', source: 'legacy',
      session_id: 'legacy-session', tasks: [{ task_id: 'dev-server', task_type: 'local_bash', description: 'Development server' }] }));
  });
  const panel = page.locator('.claude-background-tasks');
  await expect(panel).toContainText('1 background task running');
  await panel.getByRole('button', { name: 'Stop background tasks' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__ultraMessages.some((line: string) => line.startsWith('interrupt_session:')))).toBe(true);
  // Recovery can change the active provider without a session clear. Exercise
  // the snapshot handler itself, so a session reset cannot mask a stale panel.
  await page.evaluate(() => window.applyBackendTabState?.(JSON.stringify({ provider: 'codex' })));
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'codex');
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => window.onTaskEvent?.(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed',
    source: 'legacy', session_id: 'legacy-session', tasks: [] })));
  await page.evaluate(() => window.applyBackendTabState?.(JSON.stringify({ provider: 'claude' })));
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'claude');
  await expect(panel).toHaveCount(0);
});

test('provider changes preserve the old conversation and attached draft until matching acceptance', async ({ page }) => {
  await boot(page, 'claude');
  await page.evaluate(() => {
    window.setSessionId?.('provider-switch-old');
    window.addUserMessage?.('Keep the original provider conversation');
  });
  await page.locator('.input-editable').fill('Keep this attached draft');
  await attachImage(page);
  const first = await requestProviderChange(page, 'codex');
  await page.evaluate(token => window.sessionTransitionFailed?.('Stop was not acknowledged', token), first);
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'claude');
  await expect(page.locator('.input-editable')).toHaveText('Keep this attached draft');
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  await expect(page.getByText('Keep the original provider conversation', { exact: true })).toBeVisible();

  const second = await requestProviderChange(page, 'codex');
  expect(second).not.toBe(first);
  await page.evaluate(token => {
    window.clearMessages?.(90, token);
    window.historyLoadComplete?.(0, token);
  }, first);
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'claude');
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  await page.evaluate(token => {
    window.sessionTransitionStarted?.('', '', token);
    window.clearMessages?.(100, token);
    window.setSessionId?.('', token);
    window.historyLoadComplete?.(0, token);
  }, second);
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'codex');
  await expect(page.locator('.input-editable')).toHaveText('');
  await expect(page.locator('.attachment-item')).toHaveCount(0);
  await expect(page.getByText('Keep the original provider conversation', { exact: true })).toHaveCount(0);
});

async function requestNewSession(page: Page): Promise<string> {
  const previousCount = await page.evaluate(() => ((window as any).__ultraMessages as string[])
    .filter(line => line.startsWith('create_new_session:')).length);
  await page.locator('.input-editable').fill('/new');
  await page.locator('.input-editable').press('Enter');
  let token = '';
  await expect.poll(async () => {
    token = await page.evaluate(count => {
      const requests = ((window as any).__ultraMessages as string[]).filter(line => line.startsWith('create_new_session:'));
      const request = requests.length > count ? requests.at(-1) : null;
      return request ? JSON.parse(request.slice('create_new_session:'.length)).transitionToken : '';
    }, previousCount);
    return token;
  }).not.toBe('');
  return token;
}

test('failed New Session preserves the conversation and sends the queued attachment after the old turn ends', async ({ page }) => {
  await boot(page, 'claude');
  await page.evaluate(() => {
    window.setSessionId?.('old-session');
    window.addUserMessage?.('Original conversation stays here');
    window.showLoading?.('true');
    window.onStreamStart?.();
  });
  await page.locator('.input-editable').fill('Queued follow-up with context');
  await attachImage(page);
  await page.locator('.input-editable').press('Enter');
  await expect(page.locator('.message-queue')).toContainText('Queued follow-up with context');
  const token = await requestNewSession(page);
  await expect(page.locator('.message-queue')).toContainText('Queued follow-up with context');
  await expect(page.getByText('Original conversation stays here', { exact: true })).toBeVisible();
  await page.evaluate(transitionToken => {
    window.onStreamEnd?.();
    window.showLoading?.('false');
    window.sessionTransitionFailed?.('Runtime cleanup failed', transitionToken);
  }, token);
  await expect.poll(async () => (await latestSend(page))?.text).toBe('Queued follow-up with context');
  expect((await latestSend(page)).attachments).toHaveLength(1);
  await expect(page.getByText('Original conversation stays here', { exact: true })).toBeVisible();
});

test('late callbacks from an abandoned transition cannot accept or erase a newer transition', async ({ page }) => {
  await boot(page, 'claude');
  await page.evaluate(() => {
    window.setSessionId?.('old-session');
    window.addUserMessage?.('Keep this until the current request succeeds');
  });
  const first = await requestNewSession(page);
  await page.evaluate(token => window.sessionTransitionFailed?.('First transition failed', token), first);
  const second = await requestNewSession(page);
  expect(second).not.toBe(first);
  await page.evaluate(token => {
    window.clearMessages?.(90, token);
    window.setSessionId?.('late-old-target', token);
    window.historyLoadComplete?.(0, token);
  }, first);
  await expect(page.getByText('Keep this until the current request succeeds', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__sessionTransitioning)).toBe(true);
  await page.evaluate(token => {
    window.clearMessages?.(100, token);
    window.setSessionId?.('', token);
    window.historyLoadComplete?.(0, token);
  }, second);
  await expect(page.getByText('Keep this until the current request succeeds', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__sessionTransitioning)).toBe(false);
});
