import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { OFFICE_SCENE_HEIGHT, OFFICE_SCENE_WIDTH } from '../src/petOffice/officeRenderer';

// Original two-colour fixtures; no downloaded Pet/reference-project artwork.
const GIF = 'R0lGODlhEAAQAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACAAAACwAAAAAEAAQAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAEOAAEALAAAAAAQABAAgQAA/wAAAAAAAAAAAAgdAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWBAQEAOw==';
const WEBP = 'UklGRoQAAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAA8AAA8AAFAAAAJWUDhMDwAAAC8PwAMABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAA8AAA8AAIwAAABWUDhMDwAAAC8PwAMABxDR//4HIqL/AQA=';
const ORIENTED_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3EKKKKAP/2Q==';

async function metrics(page: Page) {
  return page.evaluate(() => window.petOfficeDiagnostics?.());
}

async function chooseCount(page: Page, count: 0 | 10 | 50) {
  await page.getByRole('combobox', { name: 'Simulated sessions' }).click();
  // Ant Design's virtual aria options are intentionally hidden; use the visible row.
  await page.locator('.ant-select-item-option-content').filter({ hasText: new RegExp(`^${count}$`) }).click();
  await expect.poll(async () => (await metrics(page))?.sourceCount).toBe(count);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/office.html');
  await expect(page.getByRole('heading', { name: 'Pet Office', exact: true })).toBeVisible();
});

test('all accepted fixture sessions remain reachable through pagination, selection and filters', async ({ page }) => {
  await chooseCount(page, 50);
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(50);
  await expect.poll(async () => (await metrics(page))?.visibleSources).toBe(12);
  await page.getByRole('button', { name: 'Next floor' }).click();
  await expect(page.getByText('Floor 2 / 5')).toBeVisible();
  const last = page.getByRole('list', { name: 'Session list' }).getByRole('button').last();
  await last.click();
  await expect(page.getByText('Floor 5 / 5')).toBeVisible();
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('searchbox').fill('DATA LAB');
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(17);
  await page.getByRole('searchbox').fill('unavailable project');
  await expect(page.getByText('No matching sessions on this floor.')).toBeVisible();
  await expect.poll(async () => (await metrics(page))?.running).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('pause, host visibility and zero sessions stop animation work without losing the scene', async ({ page }) => {
  await expect.poll(async () => (await metrics(page))?.running).toBe(true);
  await page.getByRole('button', { name: 'Pause animation' }).click();
  await expect.poll(async () => (await metrics(page))?.running).toBe(false);
  const paused = (await metrics(page))?.frames;
  await page.waitForTimeout(250);
  expect((await metrics(page))?.frames).toBe(paused);
  await page.getByRole('button', { name: 'Resume animation' }).click();
  await expect.poll(async () => Number((await metrics(page))?.frames)).toBeGreaterThan(Number(paused));
  // Simulates the native visibility signal, not installed IDE minimization.
  await page.evaluate(() => window.petOfficeSetVisible?.(false));
  await expect.poll(async () => (await metrics(page))?.running).toBe(false);
  const hidden = (await metrics(page))?.frames;
  await page.waitForTimeout(250);
  expect((await metrics(page))?.frames).toBe(hidden);
  await page.evaluate(() => window.petOfficeSetVisible?.(true));
  await chooseCount(page, 0);
  await expect(page.getByText('The office is quiet.')).toBeVisible();
  await expect.poll(async () => (await metrics(page))?.running).toBe(false);
});

test('sheet, PNG, JPEG, GIF and animated WebP previews decode and retire within the budget', async ({ page }) => {
  await page.getByRole('button', { name: 'Robot sheet fixture' }).click();
  await expect.poll(async () => (await metrics(page))?.decodedBytes).toBe(1536 * 1872 * 4);
  const staticImages = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 24, 16);
    return { png: canvas.toDataURL('image/png').split(',')[1], jpeg: canvas.toDataURL('image/jpeg').split(',')[1] };
  });
  for (const [name, mime, bytes, kind] of [
    ['preview.png', 'image/png', staticImages.png, 'static'],
    ['preview.jpg', 'image/jpeg', staticImages.jpeg, 'static'],
    ['oriented.jpg', 'image/jpeg', ORIENTED_JPEG, 'static'],
    ['preview.gif', 'image/gif', GIF, 'animated'],
    ['preview.webp', 'image/webp', WEBP, 'animated'],
  ]) {
    await page.locator('input[type=file]').setInputFiles({ name, mimeType: mime, buffer: Buffer.from(bytes, 'base64') });
    await expect.poll(async () => (await metrics(page))?.assetKind).toBe(kind);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(Number((await metrics(page))?.decodedBytes)).toBeLessThanOrEqual(32 * 1024 * 1024);
  }
  const colours = new Set<string>();
  for (let sample = 0; sample < 8; sample++) {
    colours.add(await page.locator('canvas').evaluate((canvas, size) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      return [...ctx.getImageData(Math.floor(canvas.width * 194 / size.width), Math.floor(canvas.height * 203 / size.height), 1, 1).data].slice(0, 3).join(',');
    }, { width: OFFICE_SCENE_WIDTH, height: OFFICE_SCENE_HEIGHT }));
    await page.waitForTimeout(50);
  }
  expect(colours.has('255,0,0')).toBe(true);
  expect(colours.has('0,0,255')).toBe(true);
  const largePng = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 3072; canvas.height = 2048;
    const context = canvas.getContext('2d');
    if (!context) throw Error('Canvas unavailable');
    context.fillStyle = '#00ff00'; context.fillRect(0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL('image/png').split(',')[1];
    canvas.width = 0; canvas.height = 0;
    return encoded;
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'large-valid.png', mimeType: 'image/png', buffer: Buffer.from(largePng, 'base64') });
  await expect.poll(async () => (await metrics(page))?.decodedBytes).toBe(24 * 1024 * 1024);
  // A 24-MiB asset plus the sheet would exceed the total 32-MiB art budget.
  const allocation = await page.evaluateHandle(() => {
    const samples: number[] = [];
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true, writable: true,
      value: function (this: HTMLCanvasElement, ...args: unknown[]) {
        if (this.width === 1536 && this.height === 1872) samples.push(Number(window.petOfficeDiagnostics?.().decodedBytes));
        return Reflect.apply(original, this, args);
      },
    });
    return { samples, restore: () => { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, writable: true, value: original }); } };
  });
  try {
    await page.getByRole('button', { name: 'Robot sheet fixture' }).click();
    await expect.poll(async () => (await metrics(page))?.assetKind).toBe('sheet');
    expect(await allocation.evaluate(state => state.samples)).toEqual([0]);
  } finally { await allocation.evaluate(state => state.restore()); await allocation.dispose(); }
  await page.getByRole('button', { name: 'Use built-in Pet' }).click();
  await expect.poll(async () => (await metrics(page))?.decodedBytes).toBe(0);
});

test('oversized and invalid art falls back; the entry has no chat bridge or external resource requests', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert')).toHaveText('Image exceeds the 4 MiB preview limit.');
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid image') });
  await expect(page.getByRole('alert')).toHaveText('Image signature, dimensions or content is invalid.');
  expect((await metrics(page))?.assetKind).toBe('builtin');
  const boundaries = await page.evaluate(() => ({
    chatBridge: 'sendToJava' in window,
    resources: performance.getEntriesByType('resource').map(entry => entry.name),
    simulated: window.petOfficeDiagnostics?.().simulated,
  }));
  expect(boundaries.chatBridge).toBe(false);
  expect(boundaries.resources).toEqual([]);
  expect(boundaries.simulated).toBe(true);
  let fetchedScripts = 0;
  await page.route('**/forged-office-entry.js', route => {
    fetchedScripts++;
    return route.fulfill({ contentType: 'application/javascript', body: 'window.__officeUnexpectedResource = true;' });
  });
  const blocked = await page.evaluate(() => new Promise<boolean>(resolve => {
    const script = document.createElement('script');
    script.src = '/forged-office-entry.js';
    script.onload = () => resolve(false);
    script.onerror = () => resolve(true);
    document.head.append(script);
  }));
  expect(blocked).toBe(true);
  expect(fetchedScripts).toBe(0);
  expect(await page.evaluate(() => Reflect.has(window, '__officeUnexpectedResource'))).toBe(false);
});
