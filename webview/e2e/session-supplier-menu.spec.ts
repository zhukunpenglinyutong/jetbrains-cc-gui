import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type SupplierMenuWindow = Window & {
  __supplierMessages: string[];
  __supplierBinding: { id: string; token: string; fail: boolean };
};

async function installBridge(page: Page, provider: string) {
  await page.addInitScript(({ provider, version }) => {
    localStorage.setItem('language', 'en');
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider, claudeModel: 'claude-sonnet-4-6', codexModel: 'gpt-5.5',
    }));
    const bridge = window as SupplierMenuWindow;
    bridge.__supplierMessages = [];
    bridge.__supplierBinding = { id: 'a', token: 'binding-a', fail: false };
    window.sendToJava = message => {
      bridge.__supplierMessages.push(message);
      const respond = (callback: string, data: unknown) => window.setTimeout(() => {
        const receiver = (window as unknown as Record<string, unknown>)[callback];
        if (typeof receiver === 'function') receiver(JSON.stringify(data));
      }, 0);
      if (message.startsWith('get_dependency_status:')) respond('updateDependencyStatus', {
        'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
        'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
      });
      if (message.startsWith('get_node_processes:')) respond('updateNodeProcesses', {
        snapshotAt: Date.now(), totals: { all: 0, daemon: 0, channel: 0, orphan: 0 }, processes: [],
      });
      if (/^(get_session_suppliers|set_session_supplier):/.test(message)) {
        const request = JSON.parse(message.slice(message.indexOf(':') + 1)) as {
          requestId: string; supplierId?: string; bindingToken?: string;
        };
        const binding = bridge.__supplierBinding;
        if (message.startsWith('set_session_supplier:')) {
          if (binding.fail || request.bindingToken !== binding.token) {
            respond('onSessionSuppliers', { ...request, provider, error: 'Supplier unavailable' });
            return;
          }
          binding.id = request.supplierId!;
        }
        respond('onSessionSuppliers', { requestId: request.requestId, provider, sessionId: null,
          bindingToken: binding.token, supplierId: binding.id, activeSupplierId: binding.id, busy: false,
          suppliers: [{ id: 'a', name: 'Supplier A', available: true }, { id: 'b', name: 'Supplier B', available: true }],
        });
      }
    };
  }, { provider, version: APP_VERSION });
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  expect(await page.evaluate(() => typeof window.notifySessionSupplierBindingChanged)).toBe('function');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
}

async function openSupplierMenu(page: Page) {
  await page.locator('.button-area-left .selector-button').first().click();
  await page.getByTestId('config-option-runtime-provider').hover();
  const dropdown = page.locator('.runtime-provider-dropdown');
  await expect(dropdown).toBeVisible();
  await expect(dropdown).toHaveAttribute('aria-busy', 'false');
  return dropdown;
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: existing menu owns the session supplier without an extra input strip`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await installBridge(page, provider);
    await expect(page.locator('.session-supplier-row')).toHaveCount(0);
    await expect(page.locator('.input-area > *')).toHaveCount(1);
    const dropdown = await openSupplierMenu(page);
    await expect(dropdown.getByRole('option', { name: 'Supplier A' })).toHaveAttribute('aria-selected', 'true');
    const box = await dropdown.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-2);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 2);
    await dropdown.getByRole('option', { name: 'Supplier B' }).click();
    await expect(dropdown).toHaveCount(0);
    const reopened = await openSupplierMenu(page);
    await expect(reopened.getByRole('option', { name: 'Supplier B' })).toHaveAttribute('aria-selected', 'true');
    await expect(reopened.getByRole('option', { name: 'Supplier A' })).toHaveAttribute('aria-selected', 'false');
    const messages = await page.evaluate(() => (window as SupplierMenuWindow).__supplierMessages);
    const selection = messages.filter(message => message.startsWith('set_session_supplier:'));
    expect(selection).toHaveLength(1);
    expect(JSON.parse(selection[0].slice(selection[0].indexOf(':') + 1))).toMatchObject({
      provider, supplierId: 'b', sessionId: null, bindingToken: 'binding-a',
    });
    expect(messages.filter(message => /^(switch_provider|switch_codex_provider):/.test(message))).toEqual([]);
    expect(messages.filter(message => message.startsWith('get_session_suppliers:')).length).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: testInfo.outputPath(`${provider}-supplier-menu.png`), animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}

test('failed switches retry from the same menu and a new unsaved chat uses its own binding', async ({ page }) => {
  await installBridge(page, 'codex');
  const dropdown = await openSupplierMenu(page);
  await page.evaluate(() => { (window as SupplierMenuWindow).__supplierBinding.fail = true; });
  await dropdown.getByRole('option', { name: 'Supplier B' }).click();
  await expect(dropdown.getByRole('status')).toContainText('Supplier unavailable');
  await expect(dropdown.getByRole('option', { name: 'Supplier A' })).toHaveAttribute('aria-selected', 'true');
  // Starting another chat involves leaving its current input menu.
  await page.mouse.click(8, 8);
  await page.evaluate(() => {
    (window as SupplierMenuWindow).__supplierBinding = { id: 'b', token: 'binding-new-chat', fail: false };
    window.notifySessionSupplierBindingChanged!();
  });
  const newMenu = await openSupplierMenu(page);
  await expect(newMenu.getByRole('option', { name: 'Supplier B' })).toHaveAttribute('aria-selected', 'true');
  await newMenu.getByRole('option', { name: 'Supplier A' }).click();
  await expect(dropdown).toHaveCount(0);
  const selection = await page.evaluate(() => (window as SupplierMenuWindow).__supplierMessages
    .filter(message => message.startsWith('set_session_supplier:')).at(-1)!);
  expect(JSON.parse(selection.slice(selection.indexOf(':') + 1))).toMatchObject({
    supplierId: 'a', bindingToken: 'binding-new-chat', sessionId: null,
  });
});
