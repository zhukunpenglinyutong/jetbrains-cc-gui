/**
 * End-to-end coverage for editing queued messages.
 *
 * A submission made while a turn is running is queued instead of sent. Each
 * queued row offers an edit action that takes the message back out of the queue
 * and restores it into the input draft, as if it had never been submitted.
 *
 * These tests drive that flow in a real Chromium page: queue a message while
 * the chat is busy, edit it, and assert what ends up in the draft. The four
 * paths covered are the ones a user can actually reach here - restore into an
 * empty draft, merge into an unsent draft, restore with attachments, and remove
 * a queued row instead of editing it.
 *
 * The "attachments cannot be restored" branch is deliberately absent: the input
 * owns its attachments in this app, so it always accepts them. That branch is
 * unit tested through a stubbed target instead.
 */

import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type QueueTestWindow = Window & typeof globalThis & {
  __sentMessages: string[];
  __sentAttachments: Array<Array<{ data: string }>>;
  sendToJava?: (message: string) => void;
};

/** Text currently held by the contenteditable input, trailing newlines trimmed. */
function draftText(page: Page) {
  return page.locator('.input-editable')
    .evaluate((input) => (input as HTMLElement).innerText.replace(/[\r\n]+$/, ''));
}

function sentMessages(page: Page) {
  return page.evaluate(() => (window as QueueTestWindow).__sentMessages);
}

/** Puts the chat into the busy state that makes submissions queue instead of send. */
function startTurn(page: Page) {
  return page.evaluate(() => window.showLoading?.('true'));
}

function endTurn(page: Page) {
  return page.evaluate(() => window.showLoading?.('false'));
}

const editable = (page: Page) => page.locator('.input-editable');

/** Submits while the chat is busy and waits for the row to land in the queue. */
async function queueMessage(page: Page, text: string) {
  await editable(page).fill(text);
  await editable(page).press('Enter');
  // Match on the container: a row locator would match several rows once the
  // queue holds more than one message.
  await expect(page.locator('.message-queue')).toContainText(text);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((appVersion) => {
    localStorage.setItem('lastSeenChangelogVersion', appVersion);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      claudePermissionMode: 'bypassPermissions',
    }));

    const bridge = window as QueueTestWindow;
    bridge.__sentMessages = [];
    bridge.__sentAttachments = [];
    bridge.sendToJava = (message) => {
      if (message.startsWith('send_message:')) {
        const payload = JSON.parse(message.slice('send_message:'.length)) as { text: string };
        bridge.__sentMessages.push(payload.text);
      }
      if (message.startsWith('send_message_with_attachments:')) {
        const payload = JSON.parse(message.slice('send_message_with_attachments:'.length)) as {
          text: string; attachments: Array<{ data: string }>;
        };
        bridge.__sentMessages.push(payload.text);
        bridge.__sentAttachments.push(payload.attachments);
      }
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => {
          window.updateDependencyStatus?.(JSON.stringify({
            'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
            'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
          }));
        }, 0);
      }
    };
  }, APP_VERSION);

  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect(page.locator('.sdk-warning-bar')).toHaveCount(0);
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
});

test('a submission made while the chat is busy is queued instead of sent', async ({ page }) => {
  await startTurn(page);
  await queueMessage(page, 'first queued message');

  expect(await sentMessages(page)).toEqual([]);
  await expect(page.locator('.message-queue')).toBeVisible();
  await expect(page.locator('.input-editable')).toHaveText('');
});

test('editing a queued message restores it into the draft and sends it again', async ({ page }) => {
  await startTurn(page);
  await queueMessage(page, 'restore me');

  await page.locator('.message-queue-edit').first().click();

  await expect(page.locator('.message-queue')).toHaveCount(0);
  expect(await draftText(page)).toBe('restore me');

  // The restored draft is an ordinary draft again: once the turn ends it is
  // sent like any other message, not re-queued.
  await endTurn(page);
  await editable(page).press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['restore me']);
});

test('editing a queued message with an unsent draft appends instead of overwriting', async ({ page }) => {
  await startTurn(page);
  await queueMessage(page, 'from the queue');

  // A draft the user typed after queueing must survive the restore.
  await editable(page).fill('typed while waiting');
  await page.locator('.message-queue-edit').first().click();

  await expect(page.locator('.message-queue')).toHaveCount(0);
  expect(await draftText(page)).toBe('typed while waiting\n\nfrom the queue');
  await expect(page.locator('.toast-container')).toContainText('added to the current draft');
});

test('editing a queued message brings its attachments back', async ({ page }) => {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.fillStyle = '#ff0000';
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await editable(page).evaluate((input, data) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))],
      'queue-edit.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, base64);
  await expect(page.locator('.attachment-item')).toHaveCount(1);

  await startTurn(page);
  await queueMessage(page, 'with an image');
  // Queueing hands the attachments over with the message.
  await expect(page.locator('.attachment-item')).toHaveCount(0);

  await page.locator('.message-queue-edit').first().click();

  await expect(page.locator('.attachment-item')).toHaveCount(1);
  expect(await draftText(page)).toBe('with an image');
});

/**
 * Switches the active provider through the toolbar selector. Picking a Beta
 * provider shows a one-time notice that has to be confirmed before the
 * selection is applied.
 */
async function selectProvider(page: Page, providerId: string) {
  await page.locator('.button-area-left .selector-button').nth(1).click();
  await page.locator(`[data-provider-id="${providerId}"]`).click();

  const confirm = page.locator('.alert-dialog .confirm-button');
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  }

  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', providerId);
}

test('queueing and editing behave the same on a non-Claude provider', async ({ page }) => {
  // The queue is driven by the shared busy state, not by the active provider,
  // so a Codex turn has to behave exactly like a Claude one.
  await selectProvider(page, 'codex');

  await startTurn(page);
  await queueMessage(page, 'queued on codex');

  await page.locator('.message-queue-edit').first().click();

  await expect(page.locator('.message-queue')).toHaveCount(0);
  expect(await draftText(page)).toBe('queued on codex');
});

for (const providerId of ['pi', 'opencode'] as const) {
  test(`queueing and editing work on the ${providerId} provider`, async ({ page }) => {
    await selectProvider(page, providerId);

    await startTurn(page);
    await queueMessage(page, `queued on ${providerId}`);

    await page.locator('.message-queue-edit').first().click();

    await expect(page.locator('.message-queue')).toHaveCount(0);
    expect(await draftText(page)).toBe(`queued on ${providerId}`);

    // The restored draft is sent through the provider that is active now.
    await endTurn(page);
    await editable(page).press('Enter');
    await expect.poll(() => sentMessages(page)).toEqual([`queued on ${providerId}`]);
  });
}

/** Queues `text` followed by an inline quote chip holding `quote`. */
async function queueQuotedMessage(page: Page, text: string, quote: string) {
  await editable(page).click();
  await editable(page).pressSequentially(`${text} `);
  await page.evaluate((quoteText) => window.addQuotedSnippet?.(JSON.stringify({ text: quoteText })), quote);
  await expect(editable(page).locator('.quote-tag')).toHaveCount(1);
  await editable(page).press('Enter');
  await expect(page.locator('.message-queue')).toContainText(text);
}

/**
 * Typing renders the input's tags, and that pass forgets every quote the input
 * no longer shows. Waits past the tag-rendering debounce so it has run.
 */
async function typeNextMessage(page: Page, text: string) {
  await editable(page).pressSequentially(text);
  await page.waitForTimeout(600);
}

test('a queued message keeps its quote while the next message is typed', async ({ page }) => {
  await startTurn(page);
  await queueQuotedMessage(page, 'explain this', 'quoted line');
  await typeNextMessage(page, 'next message');

  await endTurn(page);

  await expect.poll(() => sentMessages(page)).toEqual([expect.stringContaining('> quoted line')]);
});

test('editing a queued message brings its quote chip back', async ({ page }) => {
  await startTurn(page);
  await queueQuotedMessage(page, 'explain this', 'quoted line');
  await typeNextMessage(page, 'next message');

  await page.locator('.message-queue-edit').first().click();

  await expect(editable(page).locator('.quote-tag')).toHaveCount(1);
  await endTurn(page);
  await editable(page).press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual([expect.stringContaining('> quoted line')]);
});

test('removing a queued message leaves the rest of the queue alone', async ({ page }) => {
  await startTurn(page);
  await queueMessage(page, 'first queued');
  await queueMessage(page, 'second queued');
  await expect(page.locator('.message-queue-item')).toHaveCount(2);

  // Rows render reversed: the top row is the message queued last, so the first
  // remove button drops 'second queued' and leaves the one queued before it.
  await page.locator('.message-queue-remove').first().click();

  await expect(page.locator('.message-queue-item')).toHaveCount(1);
  await expect(page.locator('.message-queue')).toContainText('first queued');
  await expect(page.locator('.message-queue')).not.toContainText('second queued');
  // Removing is not editing: nothing is written back into the draft.
  expect(await draftText(page)).toBe('');
});
