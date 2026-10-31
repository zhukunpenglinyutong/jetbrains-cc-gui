/**
 * Queue steer end-to-end coverage (chromium).
 *
 * A steered message leaves the queue the moment it is dispatched, appears in the
 * transcript as an optimistic steered bubble with a pending badge, and only
 * loses that badge when the CLI folds it into the live turn. A rejected or
 * undelivered steer puts the row back without ever losing the text.
 *
 * The Java side is replaced by a `sendToJava` stub and the three steer
 * callbacks (`onProviderCapabilities`, `onSteerResult`, `onSteerFolded`) are
 * driven directly, which is exactly what the bridge does at runtime.
 */
import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type SteerTestWindow = Window & typeof globalThis & {
  __bridgeMessages: string[];
  sendToJava?: (message: string) => void;
  showLoading?: (value: string | boolean) => void;
  onSteerResult?: (json: string) => void;
  onSteerFolded?: (json: string) => void;
  onProviderCapabilities?: (json: string) => void;
};

const QUEUE_ROW = '.message-queue-item';
const QUEUE_TEXT = '.message-queue-content';
const STEER_BUTTON = '.message-queue-steer';
const STEERED_BADGE = '.message-steered-badge';
const PENDING_BADGE = '.message-steered-badge.pending';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((appVersion) => {
    localStorage.setItem('lastSeenChangelogVersion', appVersion);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      claudePermissionMode: 'bypassPermissions',
    }));

    const bridge = window as SteerTestWindow;
    bridge.__bridgeMessages = [];
    bridge.sendToJava = (message) => {
      bridge.__bridgeMessages.push(message);
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => {
          const callback = (window as unknown as Record<string, unknown>).updateDependencyStatus;
          if (typeof callback === 'function') {
            callback(JSON.stringify({
              'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
              'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
            }));
          }
        }, 0);
      }
    };
  }, APP_VERSION);
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect(page.locator('.sdk-warning-bar')).toHaveCount(0);
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
});

/** Put the chat into a live Claude turn with the given steer capability. */
async function startLiveTurn(page: Page, steerCapable: boolean) {
  await page.evaluate((capable) => {
    const bridge = window as SteerTestWindow;
    bridge.showLoading?.('true');
    bridge.onProviderCapabilities?.(JSON.stringify({ steer: capable }));
  }, steerCapable);
  // A live turn always exposes the Stop button.
  await expect(page.locator('.stop-button')).toBeVisible();
}

/** Queue a message the way a user does: type into the composer and press Enter. */
async function queueMessage(page: Page, text: string) {
  const editable = page.locator('.input-editable');
  await editable.fill(text);
  await editable.press('Enter');
  await expect(page.locator(QUEUE_TEXT).filter({ hasText: text })).toHaveCount(1);
  await expect(editable).toBeEmpty();
}

/** Queue messages and steer the given one. */
async function steerQueued(page: Page, text: string) {
  const row = page.locator(QUEUE_ROW).filter({ hasText: text });
  await row.locator(STEER_BUTTON).click();
  // The optimistic bubble is on screen and the queue row is hidden.
  await expect(page.locator(QUEUE_TEXT).filter({ hasText: text })).toHaveCount(0);
  await expect(page.locator('.message.user').filter({ hasText: text })).toHaveCount(1);
}

function steerMessages(page: Page) {
  return page.evaluate(() => (window as SteerTestWindow).__bridgeMessages
    .filter((message) => message.startsWith('steer_message:'))
    .map((message) => JSON.parse(message.slice('steer_message:'.length)) as {
      text: string; steerId: string;
    }));
}

test('the steer button only shows for a steer-capable live turn', async ({ page }) => {
  await startLiveTurn(page, false);
  await queueMessage(page, 'second message');
  await expect(page.locator(QUEUE_ROW)).toHaveCount(1);
  await expect(page.locator(STEER_BUTTON)).toHaveCount(0);

  await page.evaluate(() => {
    (window as SteerTestWindow).onProviderCapabilities?.(JSON.stringify({ steer: true }));
  });
  await expect(page.locator(STEER_BUTTON)).toHaveCount(1);

  await page.evaluate(() => {
    (window as SteerTestWindow).onProviderCapabilities?.(JSON.stringify({ steer: false }));
  });
  await expect(page.locator(STEER_BUTTON)).toHaveCount(0);
  // The message itself is untouched by a capability flip.
  await expect(page.locator(QUEUE_TEXT)).toHaveText(['second message']);
});

test('steering moves the message into the transcript immediately and keeps it pending', async ({ page }) => {
  await startLiveTurn(page, true);
  await queueMessage(page, 'inject me');

  await steerQueued(page, 'inject me');

  const dispatched = await steerMessages(page);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0].text).toBe('inject me');
  expect(dispatched[0].steerId).toEqual(expect.any(String));

  // Optimistic bubble: steered badge present, still waiting for the fold.
  const bubble = page.locator('.message.user').filter({ hasText: 'inject me' });
  await expect(bubble.locator(STEERED_BADGE)).toHaveCount(1);
  await expect(bubble.locator(PENDING_BADGE)).toHaveCount(1);

  // An accepted receipt keeps the spinner: the model has not read it yet.
  await page.evaluate((steerId) => {
    (window as SteerTestWindow).onSteerResult?.(JSON.stringify({ steerId, status: 'accepted' }));
  }, dispatched[0].steerId);
  await expect(bubble.locator(PENDING_BADGE)).toHaveCount(1);
  await expect(page.locator(QUEUE_ROW)).toHaveCount(0);
});

test('the fold clears the pending badge without duplicating the message', async ({ page }) => {
  await startLiveTurn(page, true);
  await queueMessage(page, 'folded message');
  await steerQueued(page, 'folded message');
  const [dispatched] = await steerMessages(page);
  await page.evaluate((steerId) => {
    (window as SteerTestWindow).onSteerResult?.(JSON.stringify({ steerId, status: 'accepted' }));
  }, dispatched.steerId);

  await page.evaluate(({ steerId }) => {
    (window as SteerTestWindow).onSteerFolded?.(JSON.stringify({
      steerId,
      message: { type: 'user', content: 'folded message', timestamp: Date.now() },
    }));
  }, { steerId: dispatched.steerId });

  const bubble = page.locator('.message.user').filter({ hasText: 'folded message' });
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator(PENDING_BADGE)).toHaveCount(0);
  // Still marked as steered, and the queue stayed empty.
  await expect(bubble.locator(STEERED_BADGE)).toHaveCount(1);
  await expect(page.locator(QUEUE_ROW)).toHaveCount(0);
});

test('a rejected steer retracts the bubble and restores the queue row', async ({ page }) => {
  await startLiveTurn(page, true);
  await queueMessage(page, 'rejected message');
  await steerQueued(page, 'rejected message');
  const [dispatched] = await steerMessages(page);

  await page.evaluate((steerId) => {
    (window as SteerTestWindow).onSteerResult?.(JSON.stringify({
      steerId, status: 'rejected', reason: 'no_active_turn',
    }));
  }, dispatched.steerId);

  // The row comes back and the optimistic bubble is gone.
  await expect(page.locator(QUEUE_TEXT).filter({ hasText: 'rejected message' })).toHaveCount(1);
  await expect(page.locator(STEERED_BADGE)).toHaveCount(0);
  await expect(page.locator('.message.user').filter({ hasText: 'rejected message' })).toHaveCount(0);
  await expect(page.locator('.toast-container')).toContainText(/turn/i);
});

test('an undelivered steer returns the message to the head of the queue', async ({ page }) => {
  await startLiveTurn(page, true);
  await queueMessage(page, 'older message');
  await queueMessage(page, 'undelivered message');
  expect(await page.locator(QUEUE_TEXT).allInnerTexts()).toEqual(['undelivered message', 'older message']);

  await steerQueued(page, 'undelivered message');
  const [dispatched] = await steerMessages(page);

  await page.evaluate((steerId) => {
    (window as SteerTestWindow).onSteerResult?.(JSON.stringify({ steerId, status: 'undelivered' }));
  }, dispatched.steerId);

  await expect(page.locator(QUEUE_TEXT)).toHaveText(['older message', 'undelivered message']);
  // Queue position 1 (the bottom row) is the head that dispatches next.
  const headRow = page.locator(QUEUE_ROW).filter({ hasText: 'undelivered message' });
  await expect(headRow.locator('.message-queue-number')).toHaveText('1');
  await expect(page.locator(STEERED_BADGE)).toHaveCount(0);
  await expect(page.locator('.toast-container')).toContainText(/not delivered|undelivered/i);
});
