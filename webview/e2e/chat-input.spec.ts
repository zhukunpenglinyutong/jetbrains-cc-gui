import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

type InputTestWindow = Window & typeof globalThis & {
  __sentMessages: string[];
  __nativePasteRequests: string[];
  __nativePasteScope: string;
  __sentAttachments: Array<Array<{ data: string }>>;
  sendToJava?: (message: string) => void;
  updateSendShortcut?: (payload: string) => void;
};

async function sentMessages(page: Page) {
  return page.evaluate(() => (window as InputTestWindow).__sentMessages);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((appVersion) => {
    localStorage.setItem('lastSeenChangelogVersion', appVersion);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      claudePermissionMode: 'bypassPermissions',
    }));

    const bridge = window as InputTestWindow;
    bridge.__sentMessages = [];
    bridge.__nativePasteRequests = [];
    bridge.__nativePasteScope = '';
    bridge.__sentAttachments = [];
    bridge.sendToJava = (message) => {
      if (message.startsWith('send_message:')) {
        const payload = JSON.parse(message.slice('send_message:'.length)) as { text: string };
        bridge.__sentMessages.push(payload.text);
      }
      if (message.startsWith('paste_image:')) {
        bridge.__nativePasteRequests.push(message.slice('paste_image:'.length));
      }
      if (message.startsWith('paste_image_scope:')) {
        bridge.__nativePasteScope = message.slice('paste_image_scope:'.length);
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

test('Enter sends once and a held key cannot submit the next draft', async ({ page }) => {
  const editable = page.locator('.input-editable');
  await editable.fill('first message');
  await page.keyboard.down('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['first message']);
  await expect(editable).toBeEmpty();

  await page.keyboard.insertText('next draft');
  await page.keyboard.down('Enter');
  await expect(editable).toHaveText('next draft');
  await page.keyboard.up('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['first message']);
});

test('Shift+Enter preserves a multiline message before Enter sends it', async ({ page }) => {
  const editable = page.locator('.input-editable');
  await editable.fill('first line');
  await editable.press('Shift+Enter');
  await page.keyboard.insertText('second line');
  await expect(editable).toHaveText('first line\nsecond line', { useInnerText: true });
  await editable.press('Enter');

  await expect.poll(() => sentMessages(page)).toEqual(['first line\nsecond line']);
  await expect(editable).toBeEmpty();
});

test('Cmd/Ctrl+Enter mode lets plain Enter insert a paragraph and uses the new shortcut', async ({ page }) => {
  await page.evaluate(() => {
    (window as InputTestWindow).updateSendShortcut?.(JSON.stringify({ sendShortcut: 'cmdEnter' }));
  });
  const editable = page.locator('.input-editable');
  await expect(editable).toHaveAttribute('data-placeholder', /⌘Enter/);
  await editable.fill('first line');
  await editable.press('Enter');
  await page.keyboard.insertText('second line');
  expect(await sentMessages(page)).toEqual([]);
  await editable.press('Control+Enter');

  await expect.poll(() => sentMessages(page)).toEqual(['first line\nsecond line']);
  await expect(editable).toBeEmpty();
});

test('IME confirmation keeps an unfinished composition separate from sending', async ({ page, context }) => {
  const editable = page.locator('.input-editable');
  await editable.click();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press('Enter');
  // Let the post-composition guard expire while Chromium still owns the composition.
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await expect(editable).toHaveText('中');
  expect(await sentMessages(page)).toEqual([]);

  await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await expect(editable).toHaveText('中文');
  expect(await sentMessages(page)).toEqual([]);

  await cdp.send('Input.insertText', { text: '中文' });
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['中文']);
  await expect(editable).toBeEmpty();
});

test('leaving the chat before debounce preserves the latest draft', async ({ page }) => {
  await page.locator('.input-editable').evaluate((editable) => {
    editable.textContent = 'draft saved while leaving';
    editable.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    const settingsButton = document.querySelector('.header .codicon-settings-gear')?.closest('button');
    settingsButton?.click();
  });
  await expect(page.locator('.input-editable')).toHaveCount(0);
  await page.locator('button:has(.codicon-arrow-left)').click();

  await expect(page.locator('.input-editable')).toHaveText('draft saved while leaving');
  expect(await sentMessages(page)).toEqual([]);
});

test('native image preparation preserves the draft until the owned reply arrives', async ({ page }) => {
  const editable = page.locator('.input-editable');
  await editable.fill('prompt with screenshot');
  const requestId = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('java-request-paste-image'));
    return (window as InputTestWindow).__nativePasteRequests[0];
  });
  expect(requestId).toBeTruthy();
  await editable.press('Enter');
  await expect(editable).toHaveText('prompt with screenshot');
  expect(await sentMessages(page)).toEqual([]);

  await page.evaluate((requestId) => window.dispatchEvent(new CustomEvent('java-paste-image', {
    detail: { requestId, mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' },
  })), requestId);
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  await editable.press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['prompt with screenshot']);
  expect(await page.evaluate(() => (window as InputTestWindow).__sentAttachments[0])).toHaveLength(1);
  await expect(editable).toBeEmpty();
  await expect(page.locator('.chat-input-box .attachment-item')).toHaveCount(0);
});

test('leaving and returning to chat discards the previous native image request', async ({ page }) => {
  const requestId = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('java-request-paste-image'));
    return (window as InputTestWindow).__nativePasteRequests[0];
  });
  await page.locator('.header .codicon-settings-gear').locator('..').click();
  await expect(page.locator('.input-editable')).toHaveCount(0);
  await page.locator('button:has(.codicon-arrow-left)').click();
  await expect(page.locator('.input-editable')).toBeVisible();
  await page.evaluate((requestId) => window.dispatchEvent(new CustomEvent('java-paste-image', {
    detail: { requestId, mediaType: 'image/png', base64: 'STALE' },
  })), requestId);
  await expect(page.locator('.attachment-item')).toHaveCount(0);
  await page.locator('.input-editable').fill('fresh draft');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['fresh draft']);
});

test('alternating DOM and native pastes preserves the final deliberate A/B/A image', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T00:00:00Z'));
  const imageA = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.fillStyle = '#ff0000';
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const pasteDom = () => page.locator('.input-editable').evaluate((editable, base64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), byte => byte.charCodeAt(0))], 'a.png', { type: 'image/png' }));
    editable.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, imageA);
  await pasteDom();
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  await page.evaluate((base64) => window.dispatchEvent(new CustomEvent('java-paste-image', {
    detail: { base64, mediaType: 'image/png' },
  })), imageA);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.fillStyle = '#0000ff';
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
    window.dispatchEvent(new CustomEvent('java-paste-image', {
      detail: { base64: canvas.toDataURL('image/png').split(',')[1], mediaType: 'image/png' },
    }));
  });
  await expect(page.locator('.attachment-item')).toHaveCount(2);
  await pasteDom();
  await expect(page.locator('.attachment-item')).toHaveCount(3);
  await page.locator('.input-editable').fill('three images');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['three images']);
  const attachments = await page.evaluate(() => (window as InputTestWindow).__sentAttachments[0]);
  expect(attachments.map(({ data }) => data)).toEqual([imageA, attachments[1].data, imageA]);
  expect(attachments[1].data).not.toBe(imageA);
});

test('native Enter preserves the draft until prepared attachments commit', async ({ page }) => {
  const editable = page.locator('.input-editable');
  await editable.fill('prompt with screenshot');
  await page.evaluate(async () => {
    const bridge = window as InputTestWindow;
    window.dispatchEvent(new CustomEvent('java-request-paste-image', {
      detail: { snapshotId: 'current-snapshot', scopeId: bridge.__nativePasteScope },
    }));
    const { requestId } = JSON.parse(bridge.__nativePasteRequests[0]);
    window.dispatchEvent(new CustomEvent('java-paste-image', { detail: {
      requestId, mediaType: 'image/png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    } }));
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    const input = document.querySelector('.input-editable')!;
    for (const type of ['keydown', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
    }));
  });
  expect(await sentMessages(page)).toEqual([]);
  await expect(editable).toHaveText('prompt with screenshot');
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  await editable.press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['prompt with screenshot']);
  expect(await page.evaluate(() => (window as InputTestWindow).__sentAttachments[0])).toHaveLength(1);
});

test('an old native offer cannot claim a remounted chat draft', async ({ page }) => {
  const oldScope = await page.evaluate(() => (window as InputTestWindow).__nativePasteScope);
  expect(oldScope).toBeTruthy();
  await page.locator('.header .codicon-settings-gear').locator('..').click();
  await expect(page.locator('.input-editable')).toHaveCount(0);
  expect(await page.evaluate(() => (window as InputTestWindow).__nativePasteScope)).toBe('');
  await page.locator('button:has(.codicon-arrow-left)').click();
  await expect(page.locator('.input-editable')).toBeVisible();
  const newScope = await page.evaluate(() => (window as InputTestWindow).__nativePasteScope);
  expect(newScope).not.toBe(oldScope);
  await page.evaluate((scopeId) => window.dispatchEvent(new CustomEvent('java-request-paste-image', {
    detail: { snapshotId: 'captured-before-settings', scopeId },
  })), oldScope);
  expect(await page.evaluate(() => (window as InputTestWindow).__nativePasteRequests)).toEqual([]);
  await page.locator('.input-editable').fill('new draft');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['new draft']);
});

test('DOM A then native B/A keeps all images without an initial A echo', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T00:00:00Z'));
  const imageA = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.fillStyle = '#ff0000';
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('.input-editable').evaluate((editable, base64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), byte => byte.charCodeAt(0))], 'a.png', { type: 'image/png' }));
    editable.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, imageA);
  await expect(page.locator('.attachment-item')).toHaveCount(1);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.fillStyle = '#0000ff';
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
    window.dispatchEvent(new CustomEvent('java-paste-image', {
      detail: { base64: canvas.toDataURL('image/png').split(',')[1], mediaType: 'image/png' },
    }));
  });
  await expect(page.locator('.attachment-item')).toHaveCount(2);
  await page.evaluate((base64) => window.dispatchEvent(new CustomEvent('java-paste-image', {
    detail: { base64, mediaType: 'image/png' },
  })), imageA);
  await expect(page.locator('.attachment-item')).toHaveCount(3);
  await page.locator('.input-editable').fill('three images');
  await page.locator('.input-editable').press('Enter');
  await expect.poll(() => sentMessages(page)).toEqual(['three images']);
  expect(await page.evaluate(() => (window as InputTestWindow).__sentAttachments[0])).toHaveLength(3);
});
