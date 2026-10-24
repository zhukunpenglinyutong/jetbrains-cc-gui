import { OFFICE_ART_SEATS } from '../src/petOffice/officeArtGeometry';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { liveSceneFixture } from '../src/petOffice/officeLiveFixtures';
import type { OfficeSharedState } from '../src/petOffice/officeSharedStorage';
import { OFFICE_SCENE_WIDTH } from '../src/petOffice/officeRenderer';

declare global { interface Window { officeSharedHost?: (message: string) => Promise<Record<string, unknown>[]> } }
const sceneSequences = new WeakMap<Page, number>();
function defaults(): OfficeSharedState {
  return { schemaVersion: 1, revision: 'initial', preferences: { officeName: '', limitMiB: 50, floors: Array.from({ length: 16 }, () => 'loft'), floor: 0,
    product: 'all', search: '', showIdle: false, paused: false, topmost: true, zoom: 100, presentation: { effects: true, attention: true, ambience: true, depth: true }, appearanceOverrides: {} }, bounds: { x: 0, y: 0, width: 1240, height: 900, placed: false } };
}
async function scene(page: Page, count: number) {
  const data = liveSceneFixture(Array.from({ length: count }, () => 'RUNNING'));
  const sequence = (sceneSequences.get(page) ?? 0) + 1; sceneSequences.set(page, sequence);
  const bytes = Buffer.from(JSON.stringify(data)), transferId = randomUUID(), pageGeneration = await page.evaluate(() => window.__PET_OFFICE_BOOTSTRAP__?.pageGeneration);
  const envelope = { schemaVersion: 1, pageGeneration, transferId, sequence };
  const packets = [{ ...envelope, type: 'SCENE_BEGIN', byteLength: bytes.length, chunkCount: Math.ceil(bytes.length / 32768), digest: createHash('sha256').update(bytes).digest('hex') },
    ...Array.from({ length: Math.ceil(bytes.length / 32768) }, (_, index) => ({ ...envelope, type: 'SCENE_CHUNK', index, data: bytes.subarray(index * 32768, (index + 1) * 32768).toString('base64') })),
    { ...envelope, type: 'SCENE_COMMIT' }];
  await page.evaluate(values => { values.forEach(value => window.petOfficeReceive?.(value)); }, packets);
  await expect.poll(() => page.evaluate(() => window.petOfficeDiagnostics?.().sourceCount)).toBe(count);
}

test('shared preferences, per-floor backgrounds and zoom survive a renderer owner change', async ({ context }) => {
  let saved = defaults();
  const backgrounds = new Map<number, { bytes: Buffer; mime: string }>();
  let upload: { floor: number; id: string; mime: string; digest: string; length: number; parts: Buffer[] } | null = null;
  const operations: string[] = [];
  await context.exposeFunction('officeSharedHost', async (message: string) => {
    const request = JSON.parse(message) as { command: string; operation: string; requestId: string; pageGeneration: string; payload: string };
    if (request.command !== 'storage') return [];
    operations.push(request.operation);
    const p = JSON.parse(request.payload) as Record<string, unknown>;
    const packet = (type: string, fields = {}) => ({ requestId: request.requestId, pageGeneration: request.pageGeneration, type, ...fields });
    if (request.operation === 'petChoices') return [packet('value', { choices: [{ id: 'builtin', label: 'Built-in robot' }] })];
    if (request.operation === 'preferences') {
      if (p.expectedRevision !== saved.revision) return [packet('error', { code: 'OFFICE_PREFERENCES_CONFLICT', state: saved })];
      saved = { ...saved, revision: randomUUID(), preferences: p.preferences as OfficeSharedState['preferences'] };
      return [packet('value', { state: saved })];
    }
    if (request.operation === 'backgroundRead') {
      const image = backgrounds.get(p.floor as number); if (!image) return [packet('value', { empty: true })];
      return [packet('begin', { byteLength: image.bytes.length, digest: createHash('sha256').update(image.bytes).digest('hex'), mime: image.mime }),
        ...Array.from({ length: Math.ceil(image.bytes.length / 32768) }, (_, index) => packet('chunk', { index, data: image.bytes.subarray(index * 32768, (index + 1) * 32768).toString('base64') })), packet('commit')];
    }
    if (request.operation === 'backgroundBegin') upload = { floor: p.floor as number, id: p.transferId as string, mime: p.mime as string, digest: p.digest as string, length: p.byteLength as number, parts: [] };
    else if (request.operation === 'backgroundChunk') {
      expect(p.transferId).toBe(upload?.id); expect(p.index).toBe(upload?.parts.length); upload?.parts.push(Buffer.from(p.data as string, 'base64'));
    } else if (request.operation === 'backgroundCommit') {
      expect(p.transferId).toBe(upload?.id); const bytes = Buffer.concat(upload!.parts);
      expect(bytes.length).toBe(upload?.length); expect(createHash('sha256').update(bytes).digest('hex')).toBe(upload?.digest);
      backgrounds.set(upload!.floor, { bytes, mime: upload!.mime }); upload = null;
    } else if (request.operation === 'backgroundRemove') backgrounds.delete(p.floor as number);
    else throw new Error('Unexpected storage operation');
    return [packet('value')];
  });
  const open = async () => {
    const page = await context.newPage();
    await page.addInitScript(({ initial, generation }) => {
      localStorage.setItem('language', 'en');
      window.__PET_OFFICE_BOOTSTRAP__ = { mode: 'live', pageGeneration: generation, protocolVersion: 1, language: 'en', sharedPreferences: initial };
      window.petOfficeNativeBridge = message => {
        const value = JSON.parse(message) as { command: string };
        if (value.command === 'ready') window.setTimeout(() => window.petOfficeSetVisible?.(true), 0);
        else if (value.command === 'storage') void window.officeSharedHost?.(message).then(packets => packets.forEach(packet => window.petOfficeStorageResult?.(packet)));
      };
    }, { initial: saved, generation: randomUUID() });
    await page.goto('/office.html'); await scene(page, 13);
    const focus = page.getByRole('button', { name: 'Focus sessions', exact: true });
    if (backgrounds.has(saved.preferences.floor)) await expect(focus).toBeDisabled();
    else await focus.click();
    return page;
  };
  let page = await open();
  await page.getByRole('button', { name: 'Next floor' }).click();
  await page.getByRole('combobox', { name: 'Scene style' }).click();
  await page.locator('.ant-select-item-option-content').filter({ hasText: /^Neon cyberpunk$/ }).click();
  await page.getByRole('combobox', { name: 'Scene zoom' }).click();
  await page.getByRole('option', { name: '125%', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.petOfficeDiagnostics?.().artworkTheme)).toBe('cyberpunk');
  const canvas = page.locator('.office-scene-surface > canvas');
  await expect(page.locator('.office-zoom-control .ant-select')).toHaveText('125%');
  await scene(page, 13);
  await expect.poll(() => page.evaluate(() => window.petOfficeDiagnostics?.().stale)).toBe(false);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const { width, height, logicalHeight } = await canvas.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, logicalHeight: Number(window.petOfficeDiagnostics?.().logicalHeight) };
  });
  await canvas.click({ position: { x: width * OFFICE_ART_SEATS.cyberpunk[0].x / OFFICE_SCENE_WIDTH, y: height * OFFICE_ART_SEATS.cyberpunk[0].label / logicalHeight } });
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button').nth(12)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Studio settings', exact: true }).click();
  await page.getByRole('textbox', { name: 'Office name', exact: true }).fill('My Studio 🐾');
  await page.getByRole('button', { name: 'Apply name', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Decoded image cache limit', exact: true }).fill('96');
  await page.getByRole('button', { name: 'Apply limit' }).click();
  await page.getByRole('checkbox', { name: 'Environmental animation', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Unpin Office' }).click();
  const encoded = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#b44488'; ctx.fillRect(0, 0, 24, 24); return canvas.toDataURL().split(',')[1]; });
  await page.locator('input[type=file]').setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') });
  await expect(page.getByRole('button', { name: 'Choose background' })).toHaveClass(/has-custom-background/);
  await expect.poll(() => saved.preferences).toMatchObject({ officeName: 'My Studio 🐾', floor: 1, zoom: 125, limitMiB: 96, topmost: false });
  expect(saved.preferences.presentation.depth).toBe(false); expect(saved.preferences.floors[1]).toBe('cyberpunk'); expect(backgrounds.has(1)).toBe(true);
  await page.close(); page = await open();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Studio 🐾');
  await expect(page).toHaveTitle('My Studio 🐾');
  await expect(page.getByRole('button', { name: 'Choose background' })).toHaveClass(/has-custom-background/);
  await expect(page.getByRole('button', { name: 'Pin Office' })).toBeVisible();
  await expect(page.locator('.office-background-toolbar > .ant-select')).toContainText('Neon cyberpunk');
  await page.getByRole('button', { name: 'Studio settings', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Decoded image cache limit', exact: true })).toHaveValue('96');
  await expect(page.getByRole('checkbox', { name: 'Environmental animation', exact: true })).not.toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Office name', exact: true })).toHaveValue('My Studio 🐾');
  await page.keyboard.press('Escape');
  await expect(page.locator('.office-zoom-control .ant-select')).toHaveText('125%');
  await page.getByRole('button', { name: 'Previous floor' }).click();
  await expect(page.getByRole('button', { name: 'Choose background' })).not.toHaveClass(/has-custom-background/);
  expect(backgrounds.has(1)).toBe(true); expect(operations).toContain('backgroundCommit');
  await page.close();
});
