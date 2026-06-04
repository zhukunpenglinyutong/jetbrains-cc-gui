import { expect, test, type Locator, type Page } from '@playwright/test';

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
      provider: 'opencode',
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
      provider: 'opencode',
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
      provider: 'opencode',
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

const OPENCODE_MODELS_PAYLOAD = {
  success: true,
  defaultModel: 'openai/gpt-5.5',
  defaultModelSource: 'config',
  models: [
    { id: 'opencode-default', label: 'opencode default', description: 'Uses configured model' },
    {
      id: 'openai/gpt-5.5',
      label: 'GPT-5.5',
      description: 'OpenAI GPT-5.5',
      variants: ['low', 'medium', 'high', 'xhigh'],
    },
  ],
};

const OPENCODE_AGENTS_PAYLOAD = {
  success: true,
  agents: [
    { id: 'opencode-default', name: 'opencode default', prompt: '', provider: 'opencode' },
    { id: 'opencode:build', name: 'Build', prompt: '', provider: 'opencode', agentID: 'build' },
  ],
};

async function installBridgeMocks(page: Page) {
  await page.addInitScript(({ modelsPayload, agentsPayload, processSnapshot }) => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'opencode',
      claudeModel: 'claude-sonnet-4-6',
      codexModel: 'gpt-5.5',
      openCodeModel: 'openai/gpt-5.5',
      claudePermissionMode: 'bypassPermissions',
      codexPermissionMode: 'default',
      openCodePermissionMode: 'default',
      longContextEnabled: true,
      reasoningEffort: 'high',
      openCodeModelVariant: 'xhigh',
    }));
    localStorage.setItem('lastSeenChangelogVersion', '0.4.4');

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
      if (message.startsWith('get_opencode_models:')) respond('updateOpenCodeModels', modelsPayload);
      if (message.startsWith('list_opencode_agents:') || message.startsWith('get_opencode_agents:')) respond('updateOpenCodeAgents', agentsPayload);
      if (message.startsWith('get_node_processes:')) respond('updateNodeProcesses', processSnapshot);
    };
  }, {
    modelsPayload: OPENCODE_MODELS_PAYLOAD,
    agentsPayload: OPENCODE_AGENTS_PAYLOAD,
    processSnapshot: NODE_PROCESS_SNAPSHOT,
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

async function expectSubmenuAnchoredToRow(page: Page, trigger: Locator, submenu: Locator, label: string) {
  const triggerBox = await trigger.boundingBox();
  const submenuBox = await submenu.boundingBox();
  expect(triggerBox, `${label} trigger should have a visible bounding box`).not.toBeNull();
  expect(submenuBox, `${label} submenu should have a visible bounding box`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, 'viewport should be available').not.toBeNull();
  if (!triggerBox || !submenuBox || !viewport) return;

  const verticalTolerance = 14;
  const verticalOverlap = Math.max(
    0,
    Math.min(triggerBox.y + triggerBox.height, submenuBox.y + submenuBox.height) - Math.max(triggerBox.y, submenuBox.y),
  );
  const topAligned = Math.abs(submenuBox.y - triggerBox.y) <= verticalTolerance;
  expect(topAligned || verticalOverlap > 12, `${label} should stay vertically attached to trigger row`).toBe(true);

  const rightSideGap = Math.abs(submenuBox.x - (triggerBox.x + triggerBox.width));
  const leftSideGap = Math.abs(triggerBox.x - (submenuBox.x + submenuBox.width));
  const canFitRight = triggerBox.x + triggerBox.width + submenuBox.width <= viewport.width;
  const canFitLeft = triggerBox.x - submenuBox.width >= 0;
  if (canFitRight || canFitLeft) {
    const flushTolerance = 3;
    expect(Math.min(rightSideGap, leftSideGap), `${label} should align flush when side space exists`).toBeLessThanOrEqual(flushTolerance);
    return;
  }

  const horizontalTolerance = 40;
  if (Math.min(rightSideGap, leftSideGap) <= horizontalTolerance) return;

  if (!canFitRight && !canFitLeft) {
    const overlapStart = Math.max(triggerBox.x, submenuBox.x);
    const overlapEnd = Math.min(triggerBox.x + triggerBox.width, submenuBox.x + submenuBox.width);
    const overlapWidth = Math.max(0, overlapEnd - overlapStart);
    expect(overlapWidth, `${label} should overlap trigger row when no side can fit`).toBeGreaterThan(20);
    return;
  }
  expect(Math.min(rightSideGap, leftSideGap), `${label} should be adjacent to trigger row`).toBeLessThanOrEqual(horizontalTolerance);
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

test.beforeEach(async ({ page }) => {
  await installBridgeMocks(page);
});

test('footer selector menus render inside the viewport', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.locator('.button-area-left')).toBeVisible();
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'opencode');
  await expect(page.getByText('GPT-5.5').first()).toBeVisible();

  const buttons = page.locator('.button-area-left .selector-button');
  await expect(buttons).toHaveCount(5);

  await openSelectorMenu(page, buttons.nth(0), 'config');
  await openSelectorMenu(page, buttons.nth(1), 'provider');
  await openSelectorMenu(page, buttons.nth(2), 'mode');
  await openSelectorMenu(page, buttons.nth(3), 'model');
  await openSelectorMenu(page, buttons.nth(4), 'reasoning');

  expect(errors.filter((error) => !error.includes('ResizeObserver loop'))).toEqual([]);
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

  const topLevelRows = mainDropdown.locator(':scope > .selector-option');
  const nodeProcessRow = topLevelRows.filter({ hasText: 'Node Process Manager' }).first();
  await nodeProcessRow.hover();
  const nodeDropdown = page.locator('.node-process-dropdown');
  await expect(nodeDropdown).toBeVisible();
  await expect(page.getByText('PID 3012')).toBeVisible();
  await expectInsideViewport(page, nodeDropdown, 'node process submenu');
  await expectSubmenuAnchoredToRow(page, nodeProcessRow, nodeDropdown, 'node process submenu');

  const agentsRow = topLevelRows.filter({ hasText: 'Agents' }).first();
  await agentsRow.hover();
  const agentDropdown = agentsRow.locator('.selector-dropdown').first();
  await expect(agentDropdown).toBeVisible();
  await expect(agentDropdown.getByText('Build', { exact: true })).toBeVisible();
  await expectInsideViewport(page, agentDropdown, 'agent submenu');
  await expectSubmenuAnchoredToRow(page, agentsRow, agentDropdown, 'agent submenu');

  expect(errors.filter((error) => !error.includes('ResizeObserver loop'))).toEqual([]);
});
