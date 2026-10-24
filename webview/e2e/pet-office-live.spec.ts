import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { liveSceneFixture } from '../src/petOffice/officeLiveFixtures';
import { OFFICE_ART_SEATS } from '../src/petOffice/officeArtGeometry';
import { OFFICE_SCENE_HEIGHT, OFFICE_SCENE_WIDTH } from '../src/petOffice/officeRenderer';

declare global { interface Window { officeTestCommands?: Record<string, unknown>[]; officeTestLastResyncAt?: number } }
const pageGeneration = '33333333-3333-4333-8333-333333333333';
function transfer(bytes: Buffer, type: 'SCENE' | 'ASSET', sequence: number, extra: Record<string, unknown> = {}) {
  const transferId = randomUUID(), chunkCount = Math.ceil(bytes.length / 32768);
  const envelope = { schemaVersion: 1, pageGeneration, transferId, sequence };
  return [{ ...envelope, type: `${type}_BEGIN`, byteLength: bytes.length, chunkCount, digest: createHash('sha256').update(bytes).digest('hex'), ...extra },
    ...Array.from({ length: chunkCount }, (_, index) => ({ ...envelope, type: `${type}_CHUNK`, index, data: bytes.subarray(index * 32768, (index + 1) * 32768).toString('base64') })), { ...envelope, type: `${type}_COMMIT` }];
}
async function deliver(page: Page, packets: Record<string, unknown>[]) { await page.evaluate(values => values.forEach(value => window.petOfficeReceive?.(value)), packets); }
async function scene(page: Page, value: unknown, sequence = 1) { await deliver(page, transfer(Buffer.from(JSON.stringify(value)), 'SCENE', sequence)); }
async function diagnostics(page: Page) { return page.evaluate(() => window.petOfficeDiagnostics?.()); }
async function commands(page: Page, command: string) { return page.evaluate(value => window.officeTestCommands?.filter(item => item.command === value) ?? [], command); }
async function backgroundPixel(page: Page) {
  return page.locator('.office-scene-surface > canvas').evaluate(async (actorCanvas, size) => {
    let canvas = actorCanvas;
    const environment = document.querySelector<SVGSVGElement>('.office-vector-environment');
    if (environment) {
      // Sample the rendered SVG in tests only; production keeps its DOM vector layers.
      const svg = environment.cloneNode(true) as SVGSVGElement;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('viewBox', '0 0 1160 1040'); svg.setAttribute('width', '1160'); svg.setAttribute('height', '1040');
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve(); image.onerror = () => reject(new Error('SVG unavailable'));
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      });
      canvas = document.createElement('canvas'); canvas.width = 1160; canvas.height = 1040;
      canvas.getContext('2d')!.drawImage(image, 0, 0);
    }
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
    // Average a stable logical patch across responsive sizes and both background types.
    const width = Math.max(1, Math.floor(canvas.width * 64 / size.width));
    const height = Math.max(1, Math.floor(canvas.height * 48 / size.height));
    const pixels = context.getImageData(Math.floor(canvas.width * 568 / size.width), Math.floor(canvas.height * 186 / size.height), width, height).data;
    const channels = [0, 0, 0];
    for (let index = 0; index < pixels.length; index += 4) for (let channel = 0; channel < 3; channel++) channels[channel] += pixels[index + channel];
    return channels.map(value => Math.round(value / (pixels.length / 4))).join(',');
  }, { width: OFFICE_SCENE_WIDTH, height: Number((await diagnostics(page))?.logicalHeight) });
}

// Allow subpixel interpolation when responsive controls change the raster canvas size.
async function expectRoomPixel(page: Page, expected: string, theme: string) {
  await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe(theme);
  const reference = expected.split(',').map(Number);
  await expect.poll(async () => {
    const channels = (await backgroundPixel(page)).split(',').map(Number);
    return Math.max(...channels.map((value, index) => Math.abs(value - reference[index])));
  }).toBeLessThanOrEqual(18);
}

async function backgroundImage(page: Page, color: string) {
  const encoded = await page.evaluate(value => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 320;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = value; context.fillRect(0, 0, 640, 320); return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  await expect(page.getByRole('button', { name: 'Choose background' })).not.toHaveClass(/ant-btn-loading/);
  await page.locator('input[type=file]').setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') });
  await expect(page.getByRole('button', { name: 'Choose background' })).toHaveClass(/has-custom-background/);
}
async function chooseStyle(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Scene style' }).click();
  const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByRole('option', { name, exact: true });
  // Short viewports can reposition the popup when scrolling an off-screen option.
  await option.scrollIntoViewIfNeeded();
  await expect(option).toBeInViewport({ ratio: 1 });
  await option.click();
  await expect(page.locator('.office-background-toolbar > .ant-select')).toContainText(name);
  await expect(page.getByRole('combobox', { name: 'Scene style' })).toHaveAttribute('aria-expanded', 'false');
  const ids: Record<string, string> = { 'Warm loft': 'loft', 'Neon cyberpunk': 'cyberpunk', 'Cloud sanctuary': 'cultivation', 'Starship deck': 'space', 'Forest workshop': 'forest', 'Arcane library': 'library', 'Deep-sea observatory': 'ocean', 'Zen courtyard': 'zen', 'Retro game studio': 'retro' };
  if (!(await diagnostics(page))?.backgroundCustom) await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe(ids[name]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(generation => {
    localStorage.setItem('language', 'en');
    window.__PET_OFFICE_BOOTSTRAP__ = { mode: 'live', pageGeneration: generation, language: 'en', protocolVersion: 1 };
    window.officeTestCommands = [];
    window.petOfficeNativeBridge = message => {
      const value = JSON.parse(message) as Record<string, unknown>;
      window.officeTestCommands?.push(value);
      if (value.command === 'resync') window.officeTestLastResyncAt = performance.now();
      if (value.command === 'ready') window.setTimeout(() => window.petOfficeSetVisible?.(true), 0);
    };
  }, pageGeneration);
  await page.goto('/office.html');
  await expect.poll(async () => (await commands(page, 'ready')).length).toBe(1);
  await expect(page.getByRole('heading', { name: 'Pet Office', exact: true })).toBeVisible();
  await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe('loft');
  // Existing full-floor checks intentionally use the complete room's coordinate system.
  await page.getByRole('button', { name: 'Focus sessions', exact: true }).click();
});

test('header refresh works while paused and diagnostics and settings remain independently keyboard accessible', async ({ page }) => {
  await scene(page, liveSceneFixture(['RUNNING']));
  const header = page.locator('.office-header');
  await expect(header.locator('.office-brand p')).toHaveText('One room. Many conversations. This office shows real conversations from participating IDEs. Select a desk to inspect its session.');
  await expect.poll(async () => (await diagnostics(page))?.running).toBe(true);
  await header.getByRole('button', { name: 'Pause animation' }).click();
  await expect(header.getByRole('button', { name: 'Resume animation' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await diagnostics(page))?.running).toBe(false);
  const frames = (await diagnostics(page))?.frames;
  // Initial synchronization may have consumed the receiver's two-second resync window.
  await page.waitForFunction(() => window.officeTestLastResyncAt === undefined || performance.now() - window.officeTestLastResyncAt >= 2000);
  const resyncs = (await commands(page, 'resync')).length;
  await header.getByRole('button', { name: 'Refresh scene' }).click();
  await expect.poll(async () => (await commands(page, 'resync')).length).toBe(resyncs + 1);
  await page.waitForTimeout(250);
  expect((await diagnostics(page))?.frames).toBe(frames);
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(1);

  const information = page.getByRole('button', { name: 'Scene diagnostics', exact: true });
  const appearance = page.getByText('Pets follow each project’s appearance settings. Image failures keep the session and use the built-in robot.');
  await expect(appearance).not.toBeVisible();
  await information.focus(); await page.keyboard.press('Enter');
  await expect(appearance).toBeVisible();
  await expect(page.locator('.office-diagnostics-details')).toContainText('Nine original SVG rooms');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const workspace = await page.locator('.office-workspace').boundingBox();
  const diagnosticsBounds = await page.locator('.office-diagnostics').boundingBox();
  expect(workspace).not.toBeNull(); expect(diagnosticsBounds).not.toBeNull();
  expect(diagnosticsBounds!.y + diagnosticsBounds!.height).toBeLessThanOrEqual(workspace!.y);
  await page.keyboard.press('Escape'); await expect(appearance).not.toBeVisible();
  await expect(information).toBeFocused();
  await information.locator('svg').click(); await expect(appearance).toBeVisible();
  await page.keyboard.press('Escape');
  const settings = page.getByRole('button', { name: 'Studio settings', exact: true });
  await settings.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Studio settings' })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('spinbutton', { name: 'Decoded image cache limit' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(settings).toBeFocused();
  await scene(page, liveSceneFixture(['RUNNING']), 2);
  await header.getByRole('button', { name: 'Resume animation' }).click();
  await expect.poll(async () => (await diagnostics(page))?.running).toBe(true);
  expect((await page.evaluate(() => window.officeTestCommands ?? [])).every(value => ['ready', 'metrics', 'sceneAck', 'resync'].includes(String(value.command)))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('live roster keeps idle opt-in and question navigation page-scoped without AI commands', async ({ page }) => {
  await scene(page, liveSceneFixture());
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(2);
  await expect.poll(async () => (await diagnostics(page))?.simulated).toBe(false);
  await page.getByRole('checkbox', { name: 'Show idle tabs' }).check();
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(3);
  await page.getByRole('list', { name: 'Session list' }).getByRole('button').filter({ hasText: 'AI 2' }).click();
  await page.getByRole('button', { name: 'Go to pending question' }).click();
  await expect.poll(async () => (await commands(page, 'navigate')).length).toBe(1);
  const request = (await commands(page, 'navigate'))[0]; expect(request.interactionId).toBe('interaction-1');
  await deliver(page, [{ schemaVersion: 1, pageGeneration, type: 'REQUEST_RESULT', requestId: request.requestId, result: 'STALE_INTERACTION' }]);
  await expect(page.getByText('This question has already been answered or replaced.')).toBeVisible();
  const values = await page.evaluate(() => window.officeTestCommands ?? []);
  expect(values.every(value => ['ready', 'metrics', 'sceneAck', 'navigate', 'resync'].includes(String(value.command)))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('illustrated scenes remain distinct and selectable with animation paused', async ({ page }) => {
  await scene(page, liveSceneFixture(['RUNNING', 'WAITING_USER', 'THINKING', 'RUNNING']));
  await page.getByRole('button', { name: 'Pause animation' }).click();
  const pixels = new Set<string>();
  for (const name of ['Forest workshop', 'Arcane library', 'Deep-sea observatory', 'Zen courtyard', 'Retro game studio']) {
    await chooseStyle(page, name);
    await expect(page.locator('.office-background-toolbar')).toHaveAttribute('title', `${name} · default`);
    const pixel = await backgroundPixel(page); expect(pixels.has(pixel)).toBe(false); pixels.add(pixel);
  }
  await page.reload(); await scene(page, liveSceneFixture(['RUNNING']));
  await expect(page.locator('.office-background-toolbar > .ant-select')).toContainText('Retro game studio');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const [id, name] of [
  ['loft', 'Warm loft'], ['cyberpunk', 'Neon cyberpunk'], ['cultivation', 'Cloud sanctuary'], ['space', 'Starship deck'],
  ['forest', 'Forest workshop'], ['library', 'Arcane library'], ['ocean', 'Deep-sea observatory'], ['zen', 'Zen courtyard'], ['retro', 'Retro game studio'],
] as const) {
  test(`vector room ${id} retains all twelve clickable seats without a raster room allocation`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await scene(page, liveSceneFixture(Array.from({ length: 13 }, () => 'RUNNING')));
    await page.locator('header').getByRole('button', { name: 'Pause animation' }).click();
    await chooseStyle(page, name);
    await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe(id);
    await expect.poll(async () => (await diagnostics(page))?.decodedBytes).toBe(0);
    await expect(page.locator('.office-vector-environment')).toBeVisible();
    await expect(page.locator(`.office-vector-environment use[href="#office-${id}-foreground"]`)).toHaveCount(0);
    await expect(page.locator('.office-vector-environment image, .office-vector-environment script, .office-vector-environment foreignObject')).toHaveCount(0);
    await expect(page.locator('.office-vector-foreground > use')).toHaveAttribute('href', `#office-${id}-foreground`);
    const furniture = await page.locator('.office-vector-foreground > use').evaluate(element => {
      const bounds = (element as SVGGraphicsElement).getBBox(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    const seats = OFFICE_ART_SEATS[id];
    expect(furniture.x).toBeLessThanOrEqual(Math.min(...seats.map(seat => seat.x - 100 * seat.scale)));
    expect(furniture.x + furniture.width).toBeGreaterThanOrEqual(Math.max(...seats.map(seat => seat.x + 100 * seat.scale)));
    expect(furniture.y).toBeLessThanOrEqual(Math.min(...seats.map(seat => seat.front)));
    expect(furniture.y + furniture.height).toBeGreaterThanOrEqual(Math.max(...seats.map(seat => seat.bottom)));
    const canvas = page.locator('.office-scene-surface > canvas'), bounds = await canvas.boundingBox(); expect(bounds).not.toBeNull();
    const rows = page.getByRole('list', { name: 'Session list' }).getByRole('button');
    for (const [index, seat] of OFFICE_ART_SEATS[id].entries()) {
      if (index % 4 === 0) {
        await canvas.click({ position: { x: bounds!.width * seat.x / OFFICE_SCENE_WIDTH, y: bounds!.height * (seat.y - 60 * seat.scale) / OFFICE_SCENE_HEIGHT } });
        await expect(rows.nth(index)).toHaveAttribute('aria-pressed', 'true');
      }
      await canvas.click({ position: { x: bounds!.width * seat.x / OFFICE_SCENE_WIDTH, y: bounds!.height * seat.label / OFFICE_SCENE_HEIGHT } });
      await expect(rows.nth(index)).toHaveAttribute('aria-pressed', 'true');
    }
    if (info.project.name === 'chromium-full-hd') await page.screenshot({ path: `../.codex/office-feedback-20261016/screenshots/${id}-1920.png` });
    await page.getByRole('button', { name: 'Next floor' }).click();
    await expect.poll(async () => (await diagnostics(page))?.visibleSources).toBe(1);
    await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe('loft');
    await page.getByRole('button', { name: 'Previous floor' }).click();
    await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe(id);
    await expect.poll(async () => (await diagnostics(page))?.decodedBytes).toBe(0);
    expect(await commands(page, 'navigate')).toHaveLength(0); expect(errors).toHaveLength(0);
  });
}

test('percentage zoom dropdown exposes every option and supports keyboard selection', async ({ page }) => {
  await scene(page, liveSceneFixture(Array.from({ length: 12 }, () => 'RUNNING')));
  const size = page.viewportSize()!;
  const zoom = page.getByRole('group', { name: 'Scene zoom' });
  const zoomSelect = zoom.getByRole('combobox', { name: 'Scene zoom' });
  await expect(zoomSelect).toBeVisible();
  await expect(zoom.getByRole('button', { name: /%$/ })).toHaveCount(0);
  const header = (await page.locator('.office-scene-header').boundingBox())!;
  const selectBounds = (await zoomSelect.boundingBox())!;
  expect(selectBounds.x).toBeGreaterThanOrEqual(header.x);
  expect(selectBounds.x + selectBounds.width).toBeLessThanOrEqual(header.x + header.width);
  await zoomSelect.click();
  const values = ['75%', '90%', '100%', '110%', '125%', '150%'];
  const options = page.getByRole('option');
  await expect(options).toHaveCount(6);
  await expect(options).toHaveText(values);
  const optionBounds = await options.evaluateAll(nodes => nodes.map(node => {
    const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { text: node.textContent?.trim(), y: bounds.y, height: bounds.height,
      visible: bounds.width > 0 && bounds.height > 0 && style.visibility === 'visible' && style.display !== 'none' };
  }));
  for (const option of optionBounds) {
    expect(option.visible, option.text).toBe(true);
    expect(option.y, option.text).toBeGreaterThanOrEqual(0);
    expect(option.y + option.height, option.text).toBeLessThanOrEqual(size.height);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).not.toBeVisible();
  await expect(zoom.locator('.ant-select')).toHaveText('100%');
  await zoomSelect.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  for (const value of ['110%', '125%', '150%']) {
    await zoomSelect.press('ArrowDown');
    await expect(page.locator('.ant-select-item-option-active')).toHaveText(value);
  }
  await zoomSelect.press('Enter');
  await expect(zoom.locator('.ant-select')).toHaveText('150%');
});

test('room fits the viewport and percentage zoom preserves exact desk selection', async ({ page }) => {
  const fixture = liveSceneFixture(Array.from({ length: 12 }, () => 'RUNNING'));
  await scene(page, fixture);
  const canvas = page.locator('.office-scene-surface > canvas'), viewport = page.locator('.office-canvas-wrap');
  const view = await viewport.boundingBox(), room = await canvas.boundingBox();
  expect(view).not.toBeNull(); expect(room).not.toBeNull();
  expect(room!.width).toBeLessThanOrEqual(view!.width + 1); expect(room!.height).toBeLessThanOrEqual(view!.height + 1);
  const size = page.viewportSize()!;
  if (size.width > 880 && size.height > 640) {
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height + 1);
  }
  const zoom = page.getByRole('group', { name: 'Scene zoom' });
  // Renew the host snapshot before measuring geometry so expiry cannot change the fitted room height.
  await scene(page, fixture, 2);
  await expect.poll(async () => (await diagnostics(page))?.stale).toBe(false);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const fitted = (await canvas.boundingBox())!;
  await zoom.getByRole('combobox', { name: 'Scene zoom' }).click();
  await page.getByRole('option', { name: '150%', exact: true }).click();
  await expect(zoom.locator('.ant-select')).toHaveText('150%');
  await expect.poll(async () => (await canvas.boundingBox())!.width / fitted.width).toBeCloseTo(1.5, 2);
  const enlarged = await canvas.boundingBox();
  const height = Number((await diagnostics(page))?.logicalHeight);
  await canvas.click({ position: { x: enlarged!.width * OFFICE_ART_SEATS.loft[0].x / OFFICE_SCENE_WIDTH, y: enlarged!.height * OFFICE_ART_SEATS.loft[0].label / height } });
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Fit window' }).click(); await expect(zoom.locator('.ant-select')).toHaveText('100%');
  expect(await commands(page, 'navigate')).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('independent settings dialog applies bounded cache configuration without expanding the scene', async ({ page }) => {
  await scene(page, liveSceneFixture(['RUNNING']));
  const before = await page.locator('.office-canvas-wrap').boundingBox();
  const trigger = page.getByRole('button', { name: 'Studio settings', exact: true }); await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Studio settings' }); await expect(dialog).toBeVisible();
  const limit = dialog.getByRole('spinbutton', { name: 'Decoded image cache limit' });
  await limit.fill('15'); await expect(dialog.getByRole('button', { name: 'Apply limit' })).toBeDisabled();
  await limit.fill('96'); await dialog.getByRole('button', { name: 'Apply limit' }).click();
  await expect.poll(async () => (await diagnostics(page))?.decodedLimitBytes).toBe(96 * 1024 * 1024);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  const after = await page.locator('.office-canvas-wrap').boundingBox();
  expect(after!.height).toBeCloseTo(before!.height, 0);
  await trigger.click(); await expect(limit).toHaveValue('96');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(await commands(page, 'navigate')).toHaveLength(0);
});

test('a multi-IDE roster routes foreign tabs and pending questions while keeping artwork diagnostics', async ({ page }) => {
  const value = liveSceneFixture(['RUNNING', 'WAITING_USER', 'IDLE']);
  const remote = value.snapshot.sources[1];
  remote.sourceKey.instanceId = 'instance-B';
  remote.metadata.productCode = 'PC'; remote.metadata.productName = 'PyCharm';
  remote.metadata.projectId = 'project-B'; remote.metadata.projectLabel = 'Project B';
  const oldKey = `instance-A/${remote.sourceKey.contentHandleId}/${remote.sourceKey.bindingEpoch}`;
  const remoteKey = `instance-B/${remote.sourceKey.contentHandleId}/${remote.sourceKey.bindingEpoch}`;
  value.appearances[remoteKey] = { ...value.appearances[oldKey], status: 'REMOTE_PENDING' };
  delete value.appearances[oldKey];
  await scene(page, { ...value, participants: ['instance-A', 'instance-B'] });
  const list = page.getByRole('list', { name: 'Session list' });
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect.poll(async () => (await diagnostics(page))?.visibleSources).toBe(2);
  const remoteRow = list.getByRole('button').filter({ hasText: 'Project B' });
  await remoteRow.click();
  expect(await commands(page, 'navigate')).toHaveLength(0);
  await remoteRow.dblclick();
  await expect.poll(async () => (await commands(page, 'navigate')).length).toBe(1);
  const foreign = (await commands(page, 'navigate'))[0];
  expect(foreign.sourceKey).toBe(remoteKey); expect(foreign.interactionId).toBe('');
  await deliver(page, [{ type: 'REQUEST_RESULT', schemaVersion: 1, pageGeneration, requestId: foreign.requestId, result: 'ATTENTION_REQUESTED' }]);
  await expect(page.getByText('Tab selected. Windows may require you to switch to the IDE manually.')).toBeVisible();
  await page.getByRole('button', { name: 'Go to pending question' }).click();
  await expect.poll(async () => (await commands(page, 'navigate')).length).toBe(2);
  const interaction = (await commands(page, 'navigate'))[1];
  expect(interaction.sourceKey).toBe(remoteKey); expect(interaction.interactionId).toBe(remote.execution.pendingInteractionId);
  await deliver(page, [{ type: 'REQUEST_RESULT', schemaVersion: 1, pageGeneration, requestId: interaction.requestId, result: 'STALE_INTERACTION' }]);
  await page.getByRole('button', { name: 'Scene diagnostics', exact: true }).click();
  await expect(page.locator('.office-diagnostics-details')).toContainText('The Pet image from the source IDE is not available here yet. Using the built-in robot.');
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: 'Show idle tabs' }).check();
  await expect(list.getByRole('button')).toHaveCount(3);
  // The native host publishes regularly; refresh the fixture before the next route gesture.
  await scene(page, { ...value, participants: ['instance-A', 'instance-B'] }, 2);
  await list.getByRole('button').filter({ hasText: 'AI 1' }).dblclick();
  await expect.poll(async () => (await commands(page, 'navigate')).length).toBe(3);
  expect((await commands(page, 'navigate'))[2].sourceKey).toBe('instance-A/tab-0/binding-0');
  expect((await page.evaluate(() => window.officeTestCommands ?? [])).every(command => ['ready', 'metrics', 'sceneAck', 'navigate', 'resync'].includes(String(command.command)))).toBe(true);
});

test('all 256 accepted sessions and the last floor settings remain reachable at twelve seats per floor', async ({ page }) => {
  await scene(page, liveSceneFixture(Array.from({ length: 256 }, () => 'RUNNING')));
  const rows = page.getByRole('list', { name: 'Session list' }).getByRole('button');
  await expect(rows).toHaveCount(256);
  await rows.last().click();
  await expect(page.getByText('Floor 22 / 22')).toBeVisible();
  await expect.poll(async () => (await diagnostics(page))?.visibleSources).toBe(4);
  await expect(page.getByRole('button', { name: 'Next floor' })).toBeDisabled();
  await chooseStyle(page, 'Deep-sea observatory');
  await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe('ocean');
  await page.getByRole('button', { name: 'Previous floor' }).click();
  await expect(page.getByText('Floor 21 / 22')).toBeVisible();
  await expect.poll(async () => (await diagnostics(page))?.visibleSources).toBe(12);
  await rows.last().click();
  await expect.poll(async () => (await diagnostics(page))?.artworkTheme).toBe('ocean');
  await rows.nth(12).click();
  await expect(page.getByText('Floor 2 / 22')).toBeVisible();
  await expect(rows.nth(12)).toHaveAttribute('aria-pressed', 'true');
  expect(await commands(page, 'navigate')).toHaveLength(0);
});

test('live pagination retains a complete scene after broken transfers and stops hidden animation', async ({ page }) => {
  await scene(page, liveSceneFixture(Array.from({ length: 50 }, () => 'RUNNING')));
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(50);
  await expect.poll(async () => (await diagnostics(page))?.visibleSources).toBe(12);
  await expect(page.getByRole('button', { name: 'Previous floor' })).toHaveAccessibleName('Previous floor');
  await expect(page.getByRole('button', { name: 'Next floor' })).toHaveAccessibleName('Next floor');
  await page.getByRole('button', { name: 'Next floor' }).click(); await expect(page.getByText('Floor 2 / 5')).toBeVisible();
  const packets = transfer(Buffer.from(JSON.stringify(liveSceneFixture())), 'SCENE', 2);
  await deliver(page, [packets[0], packets.at(-1)!]);
  await expect(page.getByText('Scene validation failed; waiting for a complete snapshot.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(50);
  await deliver(page, transfer(Buffer.from(JSON.stringify(liveSceneFixture())), 'SCENE', 3).map(packet => ({ ...packet, pageGeneration: 'old-page' })));
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(50);
  await page.evaluate(() => window.petOfficeSetVisible?.(false)); await expect.poll(async () => (await diagnostics(page))?.running).toBe(false);
  const frames = (await diagnostics(page))?.frames; await page.waitForTimeout(250); expect((await diagnostics(page))?.frames).toBe(frames);
});

test('live image transfers use digest validation, shared decoding and keep rows on failure', async ({ page }) => {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#ee6633'; context.fillRect(0, 0, 16, 16); return canvas.toDataURL('image/png').split(',')[1];
  });
  const bytes = Buffer.from(base64, 'base64'), digest = createHash('sha256').update(bytes).digest('hex'), value = liveSceneFixture(['RUNNING', 'RUNNING']);
  const manifest = { digest, kind: 'image', mime: 'image/png', width: 16, height: 16, byteLength: bytes.length };
  for (const source of Object.values(value.appearances)) Object.assign(source, { status: 'READY', manifest });
  await scene(page, value);
  await expect.poll(async () => (await commands(page, 'asset')).length).toBe(1);
  const request = (await commands(page, 'asset'))[0];
  await deliver(page, transfer(bytes, 'ASSET', 0, { requestId: request.requestId, sourceKey: request.sourceKey, appearanceRevision: request.appearanceRevision, manifest }));
  await expect.poll(async () => (await diagnostics(page))?.decodedBytes).toBe(1024);
  await page.getByRole('list', { name: 'Session list' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Scene diagnostics', exact: true }).click();
  await expect(page.locator('.office-diagnostics-details')).toContainText('Pet images 1');
  for (const source of Object.values(value.appearances)) { source.revision = 'b'.repeat(64); Object.assign(source.manifest, { digest: 'c'.repeat(64) }); }
  await scene(page, value, 2); await expect.poll(async () => (await commands(page, 'asset')).length).toBe(2);
  const next = (await commands(page, 'asset'))[1];
  // Corrupt transfer bytes cannot satisfy a declared image digest.
  const corrupted = transfer(bytes, 'ASSET', 0, { requestId: next.requestId, sourceKey: next.sourceKey, appearanceRevision: next.appearanceRevision, manifest: { ...manifest, digest: 'c'.repeat(64) } });
  corrupted[0].digest = 'c'.repeat(64); await deliver(page, corrupted);
  await expect(page.locator('.office-image-issues')).toContainText('Pet transfer unavailable. Refresh the scene to retry.');
  await expect(page.locator('.office-selection')).not.toContainText('Pet transfer');
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(2);
  await expect.poll(async () => (await diagnostics(page))?.decodedBytes).toBe(0);
});

test('native pin control follows host confirmation and keeps its command isolated', async ({ page }) => {
  const unpin = page.getByRole('button', { name: 'Unpin Office' });
  await expect(unpin).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.office-native-actions button')).toHaveText(['Hide Office', 'Close Office', 'Unpin Office']);
  await unpin.click(); expect((await commands(page, 'setTopmost'))[0]).toEqual({ command: 'setTopmost', pageGeneration, topmost: false });
  await expect(unpin).toBeVisible();
  await page.evaluate(() => window.petOfficeSetTopmost?.(false));
  await page.getByRole('button', { name: 'Pin Office' }).click(); expect((await commands(page, 'setTopmost'))[1].topmost).toBe(true);
  await page.evaluate(() => window.petOfficeSetTopmost?.(true)); await expect(unpin).toBeVisible();
  expect((await page.evaluate(() => window.officeTestCommands ?? [])).every(value => ['ready', 'metrics', 'resync', 'setTopmost'].includes(String(value.command)))).toBe(true);
});

test('each floor saves its background across page reload and resets independently', async ({ page }) => {
  const roster = liveSceneFixture(Array.from({ length: 50 }, () => 'RUNNING'));
  await scene(page, roster); await backgroundImage(page, '#b24949'); await expect.poll(() => backgroundPixel(page)).toBe('178,73,73');
  await page.getByRole('button', { name: 'Next floor' }).click();
  await expect(page.locator('.office-background-toolbar')).toHaveAttribute('title', 'Warm loft · default');
  await backgroundImage(page, '#426ca2'); await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await page.getByRole('button', { name: 'Previous floor' }).click(); await expect.poll(() => backgroundPixel(page)).toBe('178,73,73');
  await page.reload(); await scene(page, roster); await expect.poll(() => backgroundPixel(page)).toBe('178,73,73');
  await page.getByRole('button', { name: 'Next floor' }).click(); await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await page.getByRole('button', { name: 'Restore default' }).click(); await expect(page.getByRole('button', { name: 'Choose background' })).not.toHaveClass(/has-custom-background/);
  await expect.poll(async () => (await diagnostics(page))?.decodedBytes).toBe(0);
  await page.getByRole('button', { name: 'Previous floor' }).click(); await expect.poll(() => backgroundPixel(page)).toBe('178,73,73');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid or oversized backgrounds preserve the admitted scene and Pet rows', async ({ page }) => {
  await scene(page, liveSceneFixture(['RUNNING'])); await backgroundImage(page, '#426ca2');
  await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid image') });
  await expect(page.getByRole('alert')).toBeVisible(); await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await page.locator('input[type=file]').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert')).toHaveText('Choose an image up to 4 MiB.'); await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await page.locator('input[type=file]').setInputFiles({ name: 'untrusted.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.petOfficeNativeBridge("unexpected")</script></svg>') });
  await expect(page.getByRole('alert')).toHaveText('Use a valid, static PNG, JPEG or WebP image.');
  await expect.poll(() => backgroundPixel(page)).toBe('66,108,162'); await expect(page.locator('.office-vector-environment')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Restore default' }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('scene styles persist separately per floor, repaint while paused and preserve uploaded backgrounds', async ({ page }) => {
  const roster = liveSceneFixture(Array.from({ length: 50 }, () => 'RUNNING'));
  await scene(page, roster); await page.locator('header').getByRole('button', { name: 'Pause animation' }).click();
  const loft = await backgroundPixel(page);
  await chooseStyle(page, 'Neon cyberpunk'); await expect.poll(() => backgroundPixel(page)).not.toBe(loft);
  const cyber = await backgroundPixel(page);
  await page.getByRole('button', { name: 'Next floor' }).click(); await chooseStyle(page, 'Cloud sanctuary');
  await expect.poll(() => backgroundPixel(page)).not.toBe(cyber);
  const sanctuary = await backgroundPixel(page);
  await page.reload(); await scene(page, roster);
  await expect(page.locator('.office-background-toolbar > .ant-select')).toContainText('Neon cyberpunk');
  await expectRoomPixel(page, cyber, 'cyberpunk');
  await page.getByRole('button', { name: 'Next floor' }).click();
  await expect(page.locator('.office-background-toolbar > .ant-select')).toContainText('Cloud sanctuary');
  await expectRoomPixel(page, sanctuary, 'cultivation');
  await chooseStyle(page, 'Starship deck'); await expect.poll(() => backgroundPixel(page)).not.toBe(sanctuary);
  await backgroundImage(page, '#426ca2'); await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await chooseStyle(page, 'Neon cyberpunk'); await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await page.reload(); await scene(page, roster); await page.getByRole('button', { name: 'Next floor' }).click();
  await expect(page.locator('.office-background-toolbar > .ant-select')).toContainText('Neon cyberpunk');
  await expect.poll(() => backgroundPixel(page)).toBe('66,108,162');
  await page.getByRole('button', { name: 'Restore default' }).click();
  await expectRoomPixel(page, cyber, 'cyberpunk');
  await expect.poll(async () => (await diagnostics(page))?.decodedBytes).toBe(0);
  await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button')).toHaveCount(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('three crowded rows keep every label selectable without selecting the following Pet', async ({ page }) => {
  await scene(page, liveSceneFixture(Array.from({ length: 12 }, () => 'WAITING_USER')));
  await page.locator('header').getByRole('button', { name: 'Pause animation' }).click();
  const canvas = page.locator('.office-scene-surface > canvas'), bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  for (let row = 0; row < 3; row++) {
    await canvas.click({ position: { x: bounds!.width * OFFICE_ART_SEATS.loft[row * 4].x / OFFICE_SCENE_WIDTH, y: bounds!.height * OFFICE_ART_SEATS.loft[row * 4].label / OFFICE_SCENE_HEIGHT } });
    await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button').nth(row * 4)).toHaveAttribute('aria-pressed', 'true');
  }
  // The gap between labels and the next actor is deliberately not a hit target.
  const selected = page.getByRole('list', { name: 'Session list' }).getByRole('button').nth(8);
  await canvas.click({ position: { x: bounds!.width * 580 / OFFICE_SCENE_WIDTH, y: bounds!.height * 950 / OFFICE_SCENE_HEIGHT } });
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
});

test('single click inspects, double click and Enter open their exact tab with fenced results', async ({ page }) => {
  const value = liveSceneFixture(['RUNNING', 'RUNNING', 'RUNNING']); value.snapshot.sources[2].routeStatus = 'CLOSED';
  await scene(page, value);
  const rows = page.getByRole('list', { name: 'Session list' }).getByRole('button');
  await rows.nth(0).click(); await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true'); expect(await commands(page, 'navigate')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Open tab', exact: true })).toHaveCount(0); await expect(page.locator('.office-recent')).toContainText('No recent results');
  await rows.nth(1).dblclick(); await expect.poll(async () => (await commands(page, 'navigate')).length).toBe(1);
  const first = (await commands(page, 'navigate'))[0]; expect(first.sourceKey).toBe('instance-A/tab-1/binding-1'); expect(first.interactionId).toBe('');
  await rows.nth(0).click(); await deliver(page, [{ schemaVersion: 1, pageGeneration, type: 'REQUEST_RESULT', requestId: first.requestId, result: 'ACTIVATED' }]);
  await expect(page.locator('.office-selection')).not.toContainText('Tab opened.');
  await rows.nth(0).focus(); await page.keyboard.press('Enter'); await expect.poll(async () => (await commands(page, 'navigate')).length).toBe(2);
  const second = (await commands(page, 'navigate'))[1]; expect(second.sourceKey).toBe('instance-A/tab-0/binding-0');
  await rows.nth(1).dblclick(); expect(await commands(page, 'navigate')).toHaveLength(2);
  await deliver(page, [{ schemaVersion: 1, pageGeneration, type: 'REQUEST_RESULT', requestId: second.requestId, result: 'ACTIVATED' }]);
  await rows.nth(2).dblclick(); expect(await commands(page, 'navigate')).toHaveLength(2);
});

test('three distinct full atlases across four projects share pixels, actions and diagnostics without fallback', async ({ page }) => {
  const images = await page.evaluate(() => ['#e54b4b', '#4bb278', '#8066d6'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 1872; const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    for (let row = 0; row < 9; row++) for (let column = 0; column < 8; column++) {
      context.fillStyle = color; context.fillRect(column * 192, row * 208, 192, 208);
      context.fillStyle = '#e4c865'; context.fillRect(column * 192 + 8 + column * 4, row * 208 + 8, 8, 8 + row * 4);
    }
    const result = canvas.toDataURL('image/png').split(',')[1]; canvas.width = 0; canvas.height = 0; return result;
  }));
  const value = liveSceneFixture(['RUNNING', 'RUNNING', 'RUNNING', 'RUNNING']);
  const bytes = images.map(encoded => Buffer.from(encoded, 'base64'));
  const manifests = bytes.map(buffer => ({ digest: createHash('sha256').update(buffer).digest('hex'), kind: 'sheet', mime: 'image/png', width: 1536, height: 1872, byteLength: buffer.length }));
  value.snapshot.sources.forEach((source, index) => {
    source.metadata.projectLabel = `Different project ${index + 1}`;
    Object.assign(value.appearances[`instance-A/${source.metadata.contentHandleId}/${source.execution.bindingEpoch}`], { status: 'READY', manifest: manifests[index % 3] });
  });
  await scene(page, value);
  for (let index = 0; index < 3; index++) {
    await expect.poll(async () => (await commands(page, 'asset')).length).toBeGreaterThan(index);
    const request = (await commands(page, 'asset'))[index], which = manifests.findIndex(manifest => manifest.digest === request.assetDigest);
    expect(which).toBeGreaterThanOrEqual(0);
    await deliver(page, transfer(bytes[which], 'ASSET', 0, { requestId: request.requestId, sourceKey: request.sourceKey, appearanceRevision: request.appearanceRevision, manifest: manifests[which] }));
  }
  await expect.poll(async () => (await diagnostics(page))?.petImages).toBe(3);
  expect((await diagnostics(page))?.optimizedImages).toBe(0); expect((await diagnostics(page))?.fallbackPets).toBe(0);
  expect(Number((await diagnostics(page))?.decodedBytes)).toBe(3 * 1536 * 1872 * 4); expect((await diagnostics(page))?.decodedLimitBytes).toBe(50 * 1024 * 1024); expect(await commands(page, 'asset')).toHaveLength(3);
  await page.getByRole('button', { name: 'Pause animation' }).click();
  const colors = await page.locator('.office-scene-surface > canvas').evaluate((canvas, anchors) => {
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
    const height = Number(window.petOfficeDiagnostics?.().logicalHeight);
    return Array.from({ length: 4 }, (_, index) => [...context.getImageData(Math.floor(canvas.width * anchors[index].x / 1160), Math.floor(canvas.height * (anchors[index].front - 20) / height), 1, 1).data].slice(0, 3).join(','));
  }, OFFICE_ART_SEATS.loft);
  expect(colors[0]).toBe(colors[3]); expect(new Set(colors.slice(0, 3)).size).toBe(3);
  await page.getByRole('button', { name: 'Scene diagnostics', exact: true }).click(); await expect(page.locator('.office-image-issues')).toHaveCount(0);
  await expect(page.locator('.office-diagnostics-details')).toContainText('Pet images 3');
  await page.getByRole('button', { name: 'Scene diagnostics', exact: true }).click();
  await page.getByRole('button', { name: 'Studio settings', exact: true }).click(); await expect(page.locator('.office-selection')).not.toContainText('budget');
  const limit = page.getByRole('spinbutton', { name: 'Decoded image cache limit' });
  await expect(limit).toHaveValue('50');
  for (const [limitMiB, firstRequest] of [[16, 3], [128, 6]]) {
    await limit.fill(String(limitMiB)); await page.getByRole('button', { name: 'Apply limit', exact: true }).click();
    await expect.poll(async () => (await diagnostics(page))?.decodedLimitBytes).toBe(limitMiB * 1024 * 1024);
    for (let index = firstRequest; index < firstRequest + 3; index++) {
      await expect.poll(async () => (await commands(page, 'asset')).length).toBeGreaterThan(index);
      const request = (await commands(page, 'asset'))[index], which = manifests.findIndex(manifest => manifest.digest === request.assetDigest);
      expect(which).toBeGreaterThanOrEqual(0);
      await deliver(page, transfer(bytes[which], 'ASSET', 0, { requestId: request.requestId, sourceKey: request.sourceKey, appearanceRevision: request.appearanceRevision, manifest: manifests[which] }));
    }
    await expect.poll(async () => (await diagnostics(page))?.petImages).toBe(3);
    expect((await diagnostics(page))?.fallbackPets).toBe(0);
    if (limitMiB === 16) { expect((await diagnostics(page))?.optimizedImages).toBe(3); expect(Number((await diagnostics(page))?.decodedBytes)).toBeLessThanOrEqual(8 * 1024 * 1024); }
    else expect(Number((await diagnostics(page))?.decodedBytes)).toBe(3 * 1536 * 1872 * 4);
  }
  await page.reload(); await expect.poll(async () => (await diagnostics(page))?.decodedLimitBytes).toBe(128 * 1024 * 1024);
  await page.getByRole('button', { name: 'Studio settings', exact: true }).click(); await expect(limit).toHaveValue('128');
  await page.evaluate(() => localStorage.setItem('ccgui.pet.office.cache.v1', JSON.stringify({ schemaVersion: 1, limitMiB: 16384 })));
  await page.reload(); await expect.poll(async () => (await diagnostics(page))?.decodedLimitBytes).toBe(50 * 1024 * 1024);
  await page.getByRole('button', { name: 'Studio settings', exact: true }).click(); await expect(limit).toHaveValue('50');
  await expect(page.getByRole('dialog')).toContainText('could not be restored or saved');
});


test('gentle focus follows selection and preserves aligned input after resize', async ({ page }, info) => {
  await page.reload();
  const roster = liveSceneFixture(['RUNNING', 'THINKING']);
  roster.snapshot.sources[0].metadata.projectLabel = 'idea-claude-code-gui';
  roster.snapshot.sources[1].metadata.projectLabel = 'DevelopmentWorkSpaceForPyCharm';
  roster.snapshot.sources[1].metadata.productName = 'PyCharm';
  await scene(page, roster);
  await chooseStyle(page, 'Forest workshop');
  const focus = page.getByRole('button', { name: 'Focus sessions', exact: true });
  await expect(focus).toHaveAttribute('aria-pressed', 'true');
  const canvas = page.locator('.office-scene-surface > canvas'), wrap = page.locator('.office-canvas-wrap');
  for (const size of info.project.name === 'chromium-full-hd' ? [{ width: 1920, height: 1080 }, { width: 1224, height: 861 }] : [page.viewportSize()!]) {
    await page.setViewportSize(size);
    // Narrow viewports focus horizontally while retaining the full room height.
    await expect.poll(async () => {
      const camera = await diagnostics(page);
      return Math.min(Number(camera?.cameraWidth) / 1160, Number(camera?.cameraHeight) / 1040);
    }).toBeLessThan(1);
    expect((await canvas.boundingBox())!.width).toBeLessThanOrEqual((await wrap.boundingBox())!.width + 1);
    const d = (await diagnostics(page))!, bounds = (await canvas.boundingBox())!;
    expect(Number(d.cameraWidth)).toBeLessThanOrEqual(1160);
    expect(Number(d.cameraHeight)).toBeGreaterThanOrEqual(760);
    expect(Number(d.cameraHeight)).toBeLessThanOrEqual(1040);
    const seat = OFFICE_ART_SEATS.forest[1];
    await canvas.click({ position: { x: bounds.width * (seat.x - Number(d.cameraX)) / Number(d.cameraWidth), y: bounds.height * (seat.label - Number(d.cameraY)) / Number(d.cameraHeight) } });
    await expect(page.getByRole('list', { name: 'Session list' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    if (info.project.name === 'chromium-full-hd') await page.screenshot({ path: `../.codex/office-feedback-20261016/screenshots/focus-${size.width}.png` });
  }
  const focusedWidth = (await canvas.boundingBox())!.width / Number((await diagnostics(page))!.cameraWidth);
  await focus.click(); await expect.poll(async () => (await diagnostics(page))?.cameraWidth).toBe(1160);
  const overviewWidth = (await canvas.boundingBox())!.width / 1160;
  expect(focusedWidth / overviewWidth).toBeGreaterThan(1);
  expect(focusedWidth / overviewWidth).toBeLessThanOrEqual(1.4);
  await page.getByRole('button', { name: 'Studio settings', exact: true }).click();
  const body = page.locator('.office-settings-modal .ant-modal-body');
  expect(await body.evaluate(element => getComputedStyle(element).scrollbarWidth)).toBe('thin');
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Performance settings', exact: true })).toBeVisible();
  if (info.project.name === 'chromium-full-hd') {
    await expect.poll(() => page.getByRole('dialog').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await page.screenshot({ path: '../.codex/office-feedback-20261016/screenshots/diagnostics.png' });
  }
  await page.keyboard.press('Escape');
  expect(await commands(page, 'navigate')).toHaveLength(0);
});

test('room palettes and thin scrollbars follow built-in themes while custom backgrounds retain the default UI', async ({ page }) => {
  await scene(page, liveSceneFixture(['RUNNING']));
  const root = page.locator('.office-live');
  const initial = await root.evaluate(element => getComputedStyle(element).backgroundColor);
  await chooseStyle(page, 'Arcane library');
  await expect(root).toHaveAttribute('data-ui-theme', 'library');
  expect(await root.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(initial);
  await page.getByRole('combobox', { name: 'Scene style' }).click();
  const scrollbars = await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').evaluate(element => [...element.querySelectorAll('*')]
    .filter(child => ['auto', 'scroll'].includes(getComputedStyle(child).overflowY))
    .map(child => ({ width: getComputedStyle(child).scrollbarWidth, color: getComputedStyle(child).scrollbarColor })));
  expect(scrollbars.length).toBeGreaterThan(0); expect(scrollbars.every(bar => bar.width === 'thin' && bar.color !== 'auto')).toBe(true);
  await page.keyboard.press('Escape');
  await backgroundImage(page, '#445577'); await expect(root).toHaveAttribute('data-ui-theme', 'custom');
  const custom = await root.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(custom).toBe('rgb(17, 24, 32)');
  await chooseStyle(page, 'Forest workshop'); expect(await root.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(custom);
  await page.getByRole('button', { name: 'Restore default' }).click(); await expect(root).toHaveAttribute('data-ui-theme', 'forest');
});

test('selected desk focus follows distant rows and floors without moving stable seats', async ({ page }) => {
  await scene(page, liveSceneFixture(Array.from({ length: 13 }, () => 'RUNNING')));
  await page.getByRole('button', { name: 'Focus sessions', exact: true }).click();
  const rows = page.getByRole('list', { name: 'Session list' }).getByRole('button');
  await rows.nth(11).click();
  await expect.poll(async () => {
    const view = (await diagnostics(page))!;
    return Math.abs(1040 - Number(view.cameraHeight) - Number(view.cameraY));
  }).toBeLessThan(.1);
  const d = (await diagnostics(page))!, canvas = page.locator('.office-scene-surface > canvas'), bounds = (await canvas.boundingBox())!;
  const seat = OFFICE_ART_SEATS.loft[11];
  await canvas.click({ position: { x: bounds.width * (seat.x - Number(d.cameraX)) / Number(d.cameraWidth), y: bounds.height * (seat.label - Number(d.cameraY)) / Number(d.cameraHeight) } });
  await expect(rows.nth(11)).toHaveAttribute('aria-pressed', 'true');
  await rows.nth(12).click(); await expect(page.getByText('Floor 2 / 2', { exact: true })).toBeVisible();
  await expect.poll(async () => Number((await diagnostics(page))?.cameraY)).toBe(0);
  await page.getByRole('combobox', { name: 'Scene zoom' }).click();
  await page.getByRole('option', { name: '150%', exact: true }).click();
  await rows.nth(11).click();
  const viewport = (await page.locator('.office-canvas-wrap').boundingBox())!;
  await expect.poll(async () => {
    const view = (await diagnostics(page))!, rect = (await canvas.boundingBox())!;
    const x = rect.x + rect.width * (seat.x - Number(view.cameraX)) / Number(view.cameraWidth);
    const y = rect.y + rect.height * ((seat.y + seat.label) / 2 - Number(view.cameraY)) / Number(view.cameraHeight);
    return x >= viewport.x && x <= viewport.x + viewport.width && y >= viewport.y && y <= viewport.y + viewport.height;
  }).toBe(true);
  expect(await commands(page, 'navigate')).toHaveLength(0);
});

test('recent results sort and filter while navigation uses only currently admitted routes', async ({ page }) => {
  const roster = liveSceneFixture(['RUNNING', 'RUNNING', 'RUNNING']); roster.snapshot.sources[1].routeStatus = 'CLOSED';
  const results = roster.snapshot.sources.map((source, index) => ({ sourceKey: source.sourceKey, metadata: source.metadata, provider: source.provider, modelLabel: source.modelLabel,
    turnId: source.execution.turnId, outcome: ['SUCCEEDED', 'FAILED', 'CANCELLED'][index], terminalEventId: `recent-${index}`, completedAt: Date.now() + index }));
  await scene(page, { ...roster, snapshot: { ...roster.snapshot, recentResults: results } });
  const recent = page.getByRole('list', { name: 'Recent results', exact: true });
  await expect(recent.getByRole('listitem')).toHaveCount(3); await expect(recent.getByRole('listitem').first()).toContainText('AI 3');
  await expect(recent.getByRole('button', { name: 'Open result tab' })).toHaveCount(2);
  await expect(recent.getByRole('listitem').nth(1)).toContainText('Original tab unavailable');
  await recent.getByRole('button', { name: 'Open result tab' }).first().click();
  await expect.poll(async () => (await commands(page, 'navigate')).length).toBe(1);
  const nav = (await commands(page, 'navigate'))[0]; expect(nav.sourceKey).toBe('instance-A/tab-2/binding-2'); expect(nav.routeGeneration).toBe(roster.snapshot.sources[2].routeGeneration); expect(nav.interactionId).toBe('');
  await deliver(page, [{ schemaVersion: 1, pageGeneration, type: 'REQUEST_RESULT', requestId: nav.requestId, result: 'ACTIVATED' }]);
  await page.getByRole('searchbox', { name: 'Search project, tab or provider' }).fill('claude');
  await expect(recent.getByRole('listitem')).toHaveCount(1); await expect(recent.getByRole('button')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search project, tab or provider' }).fill('');
  await page.evaluate(() => window.petOfficeSetVisible?.(false));
  await page.clock.install(); await page.clock.fastForward(16_000);
  await expect(recent.getByRole('button', { name: 'Open result tab' }).first()).toBeDisabled();
});

test('completion feedback is one-shot and never replays initial or hidden snapshots', async ({ page }) => {
  await page.clock.install();
  await scene(page, liveSceneFixture(['RUNNING']));
  const done = liveSceneFixture(['SUCCEEDED']); await scene(page, done, 2);
  await expect.poll(async () => (await diagnostics(page))?.taskEffects).toBe(1);
  await scene(page, done, 3); await page.clock.fastForward(3100);
  await expect.poll(async () => (await diagnostics(page))?.taskEffects).toBe(0);
  await scene(page, done, 4); expect((await diagnostics(page))?.taskEffects).toBe(0);
  await page.reload(); await scene(page, done); expect((await diagnostics(page))?.taskEffects).toBe(0);
  await scene(page, liveSceneFixture(['RUNNING']), 2); await page.evaluate(() => window.petOfficeSetVisible?.(false));
  const next = liveSceneFixture(['FAILED']); next.snapshot.sources[0].execution.terminalEventId = 'next-result';
  await scene(page, next, 3); expect((await diagnostics(page))?.taskEffects).toBe(0);
  await page.evaluate(() => window.petOfficeSetVisible?.(true)); await scene(page, next, 4); expect((await diagnostics(page))?.taskEffects).toBe(0);
});

test('waiting attention debounces the exact question and clears after it is answered', async ({ page }) => {
  await page.clock.install();
  const waiting = liveSceneFixture(['WAITING_USER']); await scene(page, waiting);
  for (let i = 1; i <= 3; i++) { await page.clock.fastForward(10_000); await scene(page, waiting, i + 1); }
  await expect(page.locator('.office-attention-badge')).toContainText('Waiting for your response');
  expect((await diagnostics(page))?.waitingAttention).toBe(1);
  await scene(page, liveSceneFixture(['RUNNING']), 5);
  await expect(page.locator('.office-attention-badge')).toHaveCount(0); expect((await diagnostics(page))?.waitingAttention).toBe(0);
  expect(await commands(page, 'navigate')).toHaveLength(0);
});

test('scene motion switches preserve pause and accessibility without restoring retired depth', async ({ page }) => {
  await scene(page, liveSceneFixture(['RUNNING', 'THINKING']));
  await page.getByRole('button', { name: 'Pause animation' }).click();
  const frames = (await diagnostics(page))?.frames; await page.waitForTimeout(150); expect((await diagnostics(page))?.frames).toBe(frames);
  await page.getByRole('button', { name: 'Resume animation' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await diagnostics(page))?.reducedMotion).toBe(true); await expect.poll(async () => (await diagnostics(page))?.running).toBe(false);
  await expect(page.getByRole('button', { name: 'Resume animation' })).toBeDisabled();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Studio settings', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toContainText('2.5D');
  await page.getByRole('checkbox', { name: 'Environmental animation', exact: true }).uncheck();
  await page.keyboard.press('Escape'); await page.reload(); await scene(page, liveSceneFixture(['RUNNING']));
  expect((await diagnostics(page))?.ambientMotion).toBe(false); expect((await diagnostics(page))?.depthMotion).toBeUndefined();
  expect(await commands(page, 'navigate')).toHaveLength(0);
});
