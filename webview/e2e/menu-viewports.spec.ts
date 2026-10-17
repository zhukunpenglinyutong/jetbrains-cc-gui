import { expect, test, type Locator, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type BridgeWindow = Window & typeof globalThis & {
  sendToJava?: (message: string) => void;
};

const NODE_PROCESS_SNAPSHOT = {
  snapshotAt: Date.now(),
  totals: { daemon: 1, channel: 1, orphan: 1, all: 3 },
  processes: [
    {
      id: 'daemon-1',
      kind: 'DAEMON',
      provider: 'claude',
      pid: 3010,
      alive: true,
      startedAt: Date.now() - 120_000,
      uptimeMs: 120_000,
      command: 'node daemon.js',
      heapUsed: 42 * 1024 * 1024,
      activeRequestCount: 0,
      orphan: false,
    },
    {
      id: 'channel-1',
      kind: 'CHANNEL',
      provider: 'codex',
      pid: 3011,
      alive: true,
      startedAt: Date.now() - 60_000,
      uptimeMs: 60_000,
      command: 'node channel.js',
      activeRequestCount: 1,
      tabName: 'CC GUI',
      orphan: false,
    },
    {
      id: 'orphan-1',
      kind: 'ORPHAN',
      provider: 'claude',
      pid: 3012,
      alive: true,
      startedAt: Date.now() - 30_000,
      uptimeMs: 30_000,
      command: 'node orphan.js',
      activeRequestCount: 0,
      orphan: true,
    },
  ],
};

const CLAUDE_PROVIDERS_PAYLOAD = [
  { id: 'local-settings', name: 'Use local settings.json', isActive: true },
  { id: 'cli-login', name: 'Use CLI login', isActive: false },
  { id: 'proxy-a', name: 'Proxy A', remark: 'fast route', isActive: false },
];

const CODEX_PROVIDERS_PAYLOAD = [
  { id: 'codex-cli-login', name: 'Use local Codex config', isActive: true },
  { id: 'codex-proxy', name: 'Codex Proxy', remark: 'workspace config', isActive: false },
];

const LONG_MODEL = {
  id: 'vendor/super-long-model-name-that-should-not-force-horizontal-overflow-in-selector-menus',
  label: 'Extremely Long Claude-Compatible Model Display Name With Multiple Provider And Capability Suffixes',
  description: 'A very long model description that should remain clipped inside the selector row instead of pushing the dropdown outside the visible webview viewport.',
};

const SEARCH_TARGET_MODEL = {
  id: 'vendor/large-model-search-target-220',
  label: 'Large Model Search Target 220',
  description: 'Model outside the initial render cap that should still be selectable through search.',
};

const LARGE_MODEL_LIST = Array.from({ length: 240 }, (_, index) => {
  if (index === 220) return SEARCH_TARGET_MODEL;
  const padded = String(index).padStart(3, '0');
  return {
    id: `vendor/large-model-${padded}`,
    label: `Large Model ${padded}`,
    description: `Large model fixture ${padded}`,
  };
});

async function installBridgeMocks(page: Page, customModels = [LONG_MODEL]) {
  await page.addInitScript(({ processSnapshot, claudeProviders, codexProviders, models, appVersion }) => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      codexModel: 'gpt-5.5',
      claudePermissionMode: 'bypassPermissions',
      codexPermissionMode: 'default',
      longContextEnabled: true,
      reasoningEffort: 'high',
    }));
    localStorage.setItem('claude-custom-models', JSON.stringify(models));
    localStorage.setItem('lastSeenChangelogVersion', appVersion);

    const hideVConsole = () => {
      const style = document.createElement('style');
      style.textContent = '#__vconsole { display: none !important; pointer-events: none !important; }';
      (document.head || document.documentElement)?.appendChild(style);
    };
    if (document.head || document.documentElement) {
      hideVConsole();
    } else {
      window.addEventListener('DOMContentLoaded', hideVConsole, { once: true });
    }

    const respond = (callbackName: string, payload: unknown) => {
      window.setTimeout(() => {
        const callback = (window as unknown as Record<string, unknown>)[callbackName];
        if (typeof callback === 'function') {
          callback(JSON.stringify(payload));
        }
      }, 0);
    };

    (window as BridgeWindow).sendToJava = (message: string) => {
      if (message.startsWith('get_node_processes:')) respond('updateNodeProcesses', processSnapshot);
      if (message.startsWith('get_providers:')) respond('updateProviders', claudeProviders);
      if (message.startsWith('get_codex_providers:')) respond('updateCodexProviders', codexProviders);
    };
  }, {
    processSnapshot: NODE_PROCESS_SNAPSHOT,
    claudeProviders: CLAUDE_PROVIDERS_PAYLOAD,
    codexProviders: CODEX_PROVIDERS_PAYLOAD,
    models: customModels,
    appVersion: APP_VERSION,
  });
}

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

function significantErrors(errors: string[]) {
  return errors.filter((error) => !error.includes('ResizeObserver loop'));
}

async function expectInsideViewport(page: Page, locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a visible bounding box`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, 'viewport should be available').not.toBeNull();
  if (!box || !viewport) return;

  const tolerance = 2;
  expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(-tolerance);
  expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(-tolerance);
  expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(viewport.width + tolerance);
  expect(box.y + box.height, `${label} bottom edge`).toBeLessThanOrEqual(viewport.height + tolerance);
}

async function expectContainedWithin(container: Locator, child: Locator, label: string) {
  const containerBox = await container.boundingBox();
  const childBox = await child.boundingBox();
  expect(containerBox, `${label} container should have a visible bounding box`).not.toBeNull();
  expect(childBox, `${label} child should have a visible bounding box`).not.toBeNull();
  if (!containerBox || !childBox) return;

  const tolerance = 2;
  expect(childBox.x, `${label} left edge`).toBeGreaterThanOrEqual(containerBox.x - tolerance);
  expect(childBox.x + childBox.width, `${label} right edge`).toBeLessThanOrEqual(containerBox.x + containerBox.width + tolerance);
}

async function expectSubmenuAnchoredToRow(page: Page, trigger: Locator, submenu: Locator, label: string) {
  const triggerBox = await trigger.boundingBox();
  const submenuBox = await submenu.boundingBox();
  expect(triggerBox, `${label} trigger should have a visible bounding box`).not.toBeNull();
  expect(submenuBox, `${label} submenu should have a visible bounding box`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, 'viewport should be available').not.toBeNull();
  if (!triggerBox || !submenuBox || !viewport) return;

  const verticalOverlap = Math.max(
    0,
    Math.min(triggerBox.y + triggerBox.height, submenuBox.y + submenuBox.height) - Math.max(triggerBox.y, submenuBox.y),
  );
  expect(verticalOverlap, `${label} should stay vertically attached to trigger row`).toBeGreaterThan(12);

  const rightSideGap = Math.abs(submenuBox.x - (triggerBox.x + triggerBox.width));
  const leftSideGap = Math.abs(triggerBox.x - (submenuBox.x + submenuBox.width));
  const horizontalGap = Math.min(rightSideGap, leftSideGap);
  const horizontalOverlap = Math.max(
    0,
    Math.min(triggerBox.x + triggerBox.width, submenuBox.x + submenuBox.width) - Math.max(triggerBox.x, submenuBox.x),
  );

  expect(
    horizontalGap <= 48 || horizontalOverlap > 12,
    `${label} should be adjacent to or intentionally overlap trigger row`,
  ).toBe(true);
}

async function closeOpenMenus(page: Page) {
  await page.mouse.click(8, 8);
  await page.waitForTimeout(50);
}

async function openSelectorMenu(page: Page, button: Locator, label: string) {
  await button.click();
  const dropdown = page.locator('.selector-dropdown').first();
  await expect(dropdown, `${label} dropdown`).toBeVisible();
  await expectInsideViewport(page, dropdown, `${label} dropdown`);
  await closeOpenMenus(page);
}

test.beforeEach(async ({ page }, testInfo) => {
  const customModels = testInfo.title.includes('large model selector')
    ? LARGE_MODEL_LIST
    : [LONG_MODEL];
  await installBridgeMocks(page, customModels);
});

test('footer selector menus render inside the viewport', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.locator('.button-area-left')).toBeVisible();
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'claude');

  const buttons = page.locator('.button-area-left .selector-button');
  await expect(buttons).toHaveCount(4);

  await openSelectorMenu(page, buttons.nth(0), 'config');
  await openSelectorMenu(page, buttons.nth(1), 'provider');
  await openSelectorMenu(page, buttons.nth(2), 'mode');
  await openSelectorMenu(page, buttons.nth(3), 'model config');

  expect(significantErrors(errors)).toEqual([]);
});

async function expectCodexQuotaToLeaveRowsClickable(page: Page) {
  await page.goto('/');
  const providerButton = page.locator('.button-area-left .selector-button').nth(1);
  await providerButton.click();

  const providerDropdown = page.locator('.provider-dropdown');
  await expect(providerDropdown).toBeVisible();
  const codexRow = providerDropdown.locator('[data-provider-id="codex"]');
  const codexBox = await codexRow.boundingBox();
  expect(codexBox).not.toBeNull();
  await codexRow.hover();
  await expect(providerDropdown.getByText('Codex quota')).toBeVisible();
  await expectInsideViewport(page, providerDropdown, 'provider dropdown with Codex quota');

  const quotaPanel = providerDropdown.locator('.provider-quota-panel');
  await expect(quotaPanel).toBeVisible();
  await expectInsideViewport(page, quotaPanel, 'loading Codex quota');

  await page.evaluate(() => window.updateCodexSubscriptionQuota?.(JSON.stringify({
    status: 'ok',
    fetchedAt: Date.now(),
    windows: {
      fiveHour: { usedTokens: 80, remainingPercent: 20, resetsAt: Date.now() + 3_600_000 },
      weekly: { usedTokens: 68, remainingPercent: 32, resetsAt: Date.now() + 86_400_000 },
    },
  })));
  await expect(quotaPanel.getByText(/20% remaining/)).toBeVisible();
  await expectInsideViewport(page, quotaPanel, 'loaded Codex quota');
  const quotaBox = await quotaPanel.boundingBox();
  expect(quotaBox?.height).toBeGreaterThan(100);
  expect(await quotaPanel.evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
    'quota details should wrap without horizontal scrolling').toBe(true);
  const rowIsUncovered = await codexRow.evaluate((row) => {
    const rect = row.getBoundingClientRect();
    return [4, rect.width / 2, rect.width - 4].every((offset) =>
      row.contains(document.elementFromPoint(rect.left + offset, rect.top + rect.height / 2)),
    );
  });
  expect(rowIsUncovered, 'quota must leave the entire Codex row clickable').toBe(true);

  // Click where the pointer entered, not a locator that follows a displaced row.
  await page.mouse.click(codexBox!.x + codexBox!.width - 4, codexBox!.y + codexBox!.height / 2);
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'codex');
}

test('Codex quota stays within the viewport without moving provider rows', async ({ page }) => {
  await expectCodexQuotaToLeaveRowsClickable(page);
});

test('Codex quota stays readable when the viewport is both narrow and short', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 365 });
  await expectCodexQuotaToLeaveRowsClickable(page);
});

test('tabbing from a pointer-opened provider menu continues through the toolbar', async ({ page }) => {
  await page.goto('/');
  const toolbarButtons = page.locator('.button-area-left .selector-button');
  const providerButton = toolbarButtons.nth(1);

  for (const { key, targetIndex } of [{ key: 'Tab', targetIndex: 2 }, { key: 'Shift+Tab', targetIndex: 0 }]) {
    await providerButton.click();
    await expect(providerButton).toBeFocused();
    await expect(page.locator('.provider-dropdown')).toBeVisible();
    await page.keyboard.press(key);
    await expect(providerButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.provider-dropdown')).toHaveCount(0);
    await expect(toolbarButtons.nth(targetIndex)).toBeFocused();
  }
});

test('confirming a beta provider with Enter keeps the menu closed', async ({ page }) => {
  await page.goto('/');
  const providerButton = page.locator('.button-area-left .selector-button').nth(1);
  await providerButton.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-provider-id="grok"]')).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.locator('.alert-dialog .confirm-button');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('.alert-dialog')).toHaveCount(0);
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'grok');
  await expect(providerButton).toHaveAttribute('aria-expanded', 'false');
  await expect(providerButton).toBeFocused();
});

for (const fontSizeLevel of [3, 6]) {
  test(`Codex quota supports pointer entry, selection and scrolling at font level ${fontSizeLevel}`, async ({ page }) => {
    if (fontSizeLevel === 6) await page.setViewportSize({ width: 393, height: 365 });
    await page.addInitScript((level) => {
      localStorage.setItem('fontSizeLevel', String(level));
    }, fontSizeLevel);
    await page.goto('/');
    const providerButton = page.locator('.button-area-left .selector-button').nth(1);
    await providerButton.click();
    const providerDropdown = page.locator('.provider-dropdown');
    const codexRow = providerDropdown.locator('[data-provider-id="codex"]');
    await codexRow.hover();
    const quotaPanel = providerDropdown.locator('.provider-quota-panel');
    await expect(quotaPanel).toBeVisible();
    await page.evaluate(() => window.updateCodexSubscriptionQuota?.(JSON.stringify({
      status: 'ok', fetchedAt: Date.now(),
      windows: { fiveHour: { remainingPercent: 20 }, weekly: { remainingPercent: 32 } },
    })));
    await expect(quotaPanel.getByText(/20% remaining/)).toBeAttached();
    const quotaBox = await quotaPanel.boundingBox();
    expect(quotaBox).not.toBeNull();
    await page.mouse.move(quotaBox!.x + quotaBox!.width / 2, quotaBox!.y + quotaBox!.height / 2, { steps: 20 });
    await expect(quotaPanel).toBeVisible();
    await page.mouse.click(quotaBox!.x + quotaBox!.width / 2, quotaBox!.y + quotaBox!.height / 2);
    await expect(quotaPanel).toBeFocused();
    await expect(providerButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'claude');
    await expectInsideViewport(page, quotaPanel, 'interactive quota panel');

    await page.keyboard.press('End');
    const remaining = quotaPanel.getByText(/32% remaining/);
    await expect(remaining).toBeInViewport();
    await remaining.dblclick();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
    await expect(quotaPanel).toBeVisible();
    await page.keyboard.press('Home');
    await expect(quotaPanel.getByText('Codex quota')).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(providerButton).toHaveAttribute('aria-expanded', 'false');
    await expect(providerButton).toBeFocused();
  });
}

test('Codex native auto review is independent of the legacy SDK status', async ({ page }) => {
  await page.addInitScript(() => {
    // JCEF sets this before user changes can be persisted across tabs.
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    const saved = JSON.parse(localStorage.getItem('model-selection-state') || '{}');
    localStorage.setItem('model-selection-state', JSON.stringify({ ...saved, provider: 'codex' }));
  });
  await page.goto('/');
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'codex');
  await page.locator('.button-area-left .selector-button').nth(2).click();
  await expect(page.getByTestId('mode-option-default')).toBeVisible();
  await expect(page.getByTestId('mode-option-auto')).toBeVisible();
  await page.getByTestId('mode-option-auto').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('model-selection-state') || '{}',
  ).codexPermissionMode)).toBe('auto');

  // The legacy dependency callback may still report package metadata, but it
  // must not revoke the app-server native capability.
  await page.evaluate(() => window.updateDependencyStatus?.(JSON.stringify({
    'codex-sdk': { installed: true, meetsMinimumVersion: false },
  })));
  await expect.poll(() => page.evaluate(() => JSON.parse(
    localStorage.getItem('model-selection-state') || '{}',
  ).codexPermissionMode)).toBe('auto');
  await page.locator('.button-area-left .selector-button').nth(2).click();
  await expect(page.getByTestId('mode-option-default')).toBeVisible();
  await expect(page.getByTestId('mode-option-auto')).toBeVisible();
});

test('config submenus stay visible across constrained viewports', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.locator('.button-area-left')).toBeVisible();

  const configButton = page.locator('.button-area-left .selector-button').first();
  await configButton.click();
  const mainDropdown = page.locator('.selector-dropdown').first();
  await expect(mainDropdown).toBeVisible();
  await expectInsideViewport(page, mainDropdown, 'config dropdown');

  const nodeProcessRow = mainDropdown.getByTestId('config-option-node-processes');
  await nodeProcessRow.hover();
  const nodeDropdown = page.locator('.node-process-dropdown');
  await expect(nodeDropdown).toBeVisible();
  await expect(page.getByText('PID 3012')).toBeVisible();
  await expectInsideViewport(page, nodeDropdown, 'node process submenu');
  await expectSubmenuAnchoredToRow(page, nodeProcessRow, nodeDropdown, 'node process submenu');

  const runtimeProviderRow = mainDropdown.getByTestId('config-option-runtime-provider');
  await runtimeProviderRow.hover();
  const runtimeDropdown = page.locator('.runtime-provider-dropdown');
  await expect(runtimeDropdown).toBeVisible();
  await expectInsideViewport(page, runtimeDropdown, 'runtime provider submenu');
  await expectSubmenuAnchoredToRow(page, runtimeProviderRow, runtimeDropdown, 'runtime provider submenu');

  const agentRow = mainDropdown.getByTestId('config-option-agent');
  await agentRow.hover();
  const agentDropdown = agentRow.locator('.selector-dropdown').first();
  await expect(agentDropdown).toBeVisible();
  await expectInsideViewport(page, agentDropdown, 'agent submenu');
  await expectSubmenuAnchoredToRow(page, agentRow, agentDropdown, 'agent submenu');

  expect(significantErrors(errors)).toEqual([]);
});

test('long model and mode text stays contained in selector menus', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.locator('.button-area-left')).toBeVisible();

  const buttons = page.locator('.button-area-left .selector-button');
  await expect(buttons).toHaveCount(4);

  await buttons.nth(2).click();
  const modeDropdown = page.locator('.selector-dropdown').first();
  await expect(modeDropdown).toBeVisible();
  await expectInsideViewport(page, modeDropdown, 'mode dropdown with long descriptions');
  const longModeOption = modeDropdown.getByTestId('mode-option-bypassPermissions');
  const longModeDescription = longModeOption.locator('.mode-description');
  await expect(longModeDescription).toBeVisible();
  await expectContainedWithin(longModeOption, longModeDescription, 'long mode description');
  await closeOpenMenus(page);

  await buttons.nth(3).click();
  const modelConfigDropdown = page.locator('.model-config-dropdown');
  await expect(modelConfigDropdown).toBeVisible();
  await expectInsideViewport(page, modelConfigDropdown, 'model config dropdown');
  const modelDropdown = modelConfigDropdown.getByTestId('model-selector-dropdown');
  await expect(modelDropdown).toBeVisible();
  await expectInsideViewport(page, modelDropdown, 'model dropdown with long custom model');
  const longModelOption = modelDropdown.locator('.selector-option').filter({ hasText: LONG_MODEL.label }).first();
  const longModelLabel = longModelOption.locator('span').filter({ hasText: LONG_MODEL.label }).first();
  const longModelDescription = longModelOption.locator('span').filter({ hasText: LONG_MODEL.description }).first();
  await expect(longModelLabel).toBeVisible();
  await expect(longModelDescription).toBeVisible();
  await expectContainedWithin(longModelOption, longModelLabel, 'long model label');
  await expectContainedWithin(longModelOption, longModelDescription, 'long model description');

  expect(significantErrors(errors)).toEqual([]);
});

test('large model selector remains searchable and capped', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.locator('.button-area-left')).toBeVisible();

  const modelButton = page.locator('.button-area-left .selector-button').nth(3);
  await modelButton.click();
  const modelConfigDropdown = page.locator('.model-config-dropdown');
  await expect(modelConfigDropdown).toBeVisible();
  const modelDropdown = modelConfigDropdown.getByTestId('model-selector-dropdown');
  await expect(modelDropdown).toBeVisible();
  await expectInsideViewport(page, modelConfigDropdown, 'large model dropdown');

  const renderedLargeModels = modelDropdown.getByText(/^Large Model \d{3}$/);
  await expect(renderedLargeModels).toHaveCount(100);
  await expect(modelDropdown.getByTestId('model-hidden-count')).toBeVisible();
  await expect(modelDropdown.getByText(SEARCH_TARGET_MODEL.label)).toHaveCount(0);

  const searchInput = modelDropdown.getByTestId('model-search-input');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('Search Target 220');

  const targetOption = modelDropdown.locator('.selector-option').filter({ hasText: SEARCH_TARGET_MODEL.label }).first();
  await expect(targetOption).toBeVisible();
  await targetOption.click();
  await expect(targetOption).toHaveClass(/selected/);

  expect(significantErrors(errors)).toEqual([]);
});
