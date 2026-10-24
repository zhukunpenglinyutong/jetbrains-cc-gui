import { describe, expect, it, vi } from 'vitest';
import { OfficeLiveAssetPool } from './officeLiveAssets';
import { liveSceneFixture } from './officeLiveFixtures';
import { parseLiveScene } from './officeLiveModel';
import type { AssetReference } from './officeSceneReceiver';
import { inspectOfficeImage, planOfficeImageDecode, loadOfficeImage } from './officeAssets';
import type { OfficeAsset } from './officeAssets';

function imageSources(count: number, width = 8, height = 8) {
  return parseLiveScene(liveSceneFixture(Array.from({ length: count }, () => 'RUNNING'))).sources.map((source, index) => ({
    ...source, appearance: { ...source.appearance, revision: (index + 10).toString(16).padStart(64, '0'), status: 'READY',
      manifest: { digest: (index + 1).toString(16).padStart(64, '0'), kind: 'image' as const, mime: 'image/png', width, height, byteLength: 33 } },
  }));
}
function png(width = 8, height = 8) {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12); view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function asset(width = 8, height = 8): OfficeAsset {
  return { kind: 'static', name: 'pet', width, height, frames: [], durations: [], decodedBytes: width * height * 4, release: vi.fn() };
}
const settle = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
function harness(decode: typeof loadOfficeImage = vi.fn(async () => asset()), decodedBudgetBytes = () => 32 * 1024 * 1024) {
  let now = 0; const requests: AssetReference[] = [], changed = vi.fn();
  const pool = new OfficeLiveAssetPool({ request: reference => requests.push(reference), changed, decode, now: () => now, decodedBudgetBytes });
  return { pool, requests, decode, changed, advance: (value: number) => { now += value; } };
}
function compactDecoder() {
  return vi.fn<typeof loadOfficeImage>(async (file, _signal, options) => {
    const header = inspectOfficeImage(new Uint8Array(await file.arrayBuffer()), file.name), plan = planOfficeImageDecode(header, options);
    return { ...asset(plan.width, plan.height), kind: plan.cellWidth ? 'sheet' : 'static', cellWidth: plan.cellWidth, cellHeight: plan.cellHeight };
  });
}
function sheetSources(count: number, variants = count) {
  return imageSources(count, 1536, 1872).map((source, index) => ({ ...source, appearance: { ...source.appearance,
    manifest: { ...source.appearance.manifest, kind: 'sheet' as const, digest: ((index % variants) + 1).toString(16).padStart(64, '0') } } }));
}
describe('live pet image pool', () => {
  it('retains only already decoded retiring art and releases it when the finite tail ends', async () => {
    const decoded = asset(), h = harness(vi.fn(async () => decoded)), sources = imageSources(1);
    h.pool.syncSources(sources); h.pool.demand(sources); h.pool.accept(h.requests[0], png()); await settle();
    expect(h.pool.decodedBytes()).toBe(256);
    h.pool.syncSources([]); h.pool.demand([], sources);
    expect(decoded.release).not.toHaveBeenCalled(); expect(h.requests).toHaveLength(1);
    h.pool.demand([]); expect(decoded.release).toHaveBeenCalledTimes(1); expect(h.pool.decodedBytes()).toBe(0);
    h.pool.dispose(); expect(decoded.release).toHaveBeenCalledTimes(1);
  });

  it('defaults to 50 MiB and keeps three canonical atlases at their original resolution', async () => {
    const requests: AssetReference[] = [], decode = compactDecoder();
    const pool = new OfficeLiveAssetPool({ request: value => requests.push(value), changed: () => {}, decode });
    const sources = sheetSources(3); pool.syncSources(sources); pool.demand(sources);
    for (let index = 0; index < requests.length; index++) { pool.accept(requests[index], png(1536, 1872)); await settle(); }
    expect(pool.decodedBytes()).toBe(3 * 1536 * 1872 * 4);
    expect(pool.diagnostics()).toEqual({ images: 3, optimized: 0, loading: 0, fallback: 0 }); pool.dispose();
  });
  it('releases and refits cached art when the budget shrinks and restores resolution when it grows', async () => {
    let budget = 50 * 1024 * 1024;
    const decode = compactDecoder(), h = harness(decode, () => budget), sources = sheetSources(3);
    h.pool.syncSources(sources); h.pool.demand(sources);
    for (let index = 0; index < h.requests.length; index++) { h.pool.accept(h.requests[index], png(1536, 1872)); await settle(); }
    const previous = await Promise.all(decode.mock.results.map(value => value.value));
    budget = 16 * 1024 * 1024; h.pool.reconfigureBudget(); expect(previous.every(value => vi.mocked(value.release).mock.calls.length === 1)).toBe(true);
    for (let index = 3; index < h.requests.length; index++) { h.pool.accept(h.requests[index], png(1536, 1872)); await settle(); }
    expect(h.pool.decodedBytes()).toBeLessThanOrEqual(8 * 1024 * 1024); expect(sources.every(source => h.pool.status(source) === 'READY')).toBe(true);
    budget = 50 * 1024 * 1024; h.pool.reconfigureBudget();
    for (let index = 6; index < h.requests.length; index++) { h.pool.accept(h.requests[index], png(1536, 1872)); await settle(); }
    expect(h.pool.decodedBytes()).toBe(3 * 1536 * 1872 * 4); expect(h.pool.diagnostics().optimized).toBe(0); h.pool.dispose();
  });
  it('releases a noncancelable old decode after a budget change before admitting its replacement', async () => {
    let budget = 50 * 1024 * 1024, finish: ((value: OfficeAsset) => void) | undefined;
    const decode = compactDecoder(); decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const h = harness(decode, () => budget), sources = sheetSources(1);
    h.pool.syncSources(sources); h.pool.demand(sources); h.pool.accept(h.requests[0], png(1536, 1872)); await settle();
    budget = 16 * 1024 * 1024; h.pool.reconfigureBudget();
    const old: OfficeAsset = { ...asset(1536, 1872), kind: 'sheet', cellWidth: 192, cellHeight: 208 };
    finish?.(old); await settle(); expect(old.release).toHaveBeenCalledOnce();
    h.pool.accept(h.requests[1], png(1536, 1872)); await settle();
    expect(h.pool.decodedBytes()).toBeLessThanOrEqual(8 * 1024 * 1024); expect(h.pool.status(sources[0])).toBe('READY'); h.pool.dispose();
  });
  it('deduplicates a shared digest while preserving each source opacity and mapping', async () => {
    const h = harness(), sources = imageSources(2); sources[1].appearance.manifest = sources[0].appearance.manifest; sources[1].appearance.opacity = 0.5;
    h.pool.syncSources(sources); h.pool.demand(sources); expect(h.requests).toHaveLength(1);
    h.pool.accept(h.requests[0], png()); await settle(); expect(h.decode).toHaveBeenCalledTimes(1); expect(h.pool.decodedBytes()).toBe(256);
    expect(h.pool.visual(sources[0]).opacity).toBe(1); expect(h.pool.visual(sources[1]).opacity).toBe(0.5); h.pool.dispose();
  });
  it('bounds concurrent transfers to two and expires unavailable images explicitly', () => {
    const h = harness(), sources = imageSources(4); h.pool.syncSources(sources); h.pool.demand(sources); expect(h.pool.inFlight()).toBe(2);
    h.advance(15_000); h.pool.poll(); expect(h.requests).toHaveLength(4); expect(h.pool.inFlight()).toBe(2); expect(h.pool.status(sources[0])).toBe('transferTimeout'); h.pool.dispose();
  });
  it('reports a loaded shared picture ahead of a stale failure for another source revision', async () => {
    const h = harness(), sources = imageSources(2); sources[1].appearance.manifest = sources[0].appearance.manifest;
    h.pool.syncSources(sources); h.pool.demand(sources); h.pool.result(h.requests[0].requestId, 'ASSET_RETRY');
    expect(h.requests).toHaveLength(2); expect(h.pool.status(sources[0])).toBe('ASSET_RETRY');
    h.pool.accept(h.requests[1], png()); await settle(); expect(h.pool.status(sources[0])).toBe('READY'); expect(h.pool.status(sources[1])).toBe('READY'); h.pool.dispose();
  });
  it('discards old selection replies before decode', async () => {
    const h = harness(), sources = imageSources(1); h.pool.syncSources(sources); h.pool.demand(sources);
    const request = h.requests[0]; sources[0].appearance.revision = 'f'.repeat(64); h.pool.syncSources(sources); h.pool.accept(request, png()); await settle(); expect(h.decode).not.toHaveBeenCalled(); h.pool.dispose();
  });
  it('releases a noncancelable decode result after page disposal', async () => {
    const next = asset(); let finish: ((asset: OfficeAsset) => void) | undefined;
    const h = harness(vi.fn(() => new Promise<OfficeAsset>(resolve => { finish = resolve; }))), sources = imageSources(1);
    h.pool.syncSources(sources); h.pool.demand(sources); h.pool.accept(h.requests[0], png()); await settle();
    h.pool.dispose(); finish?.(next); await settle(); expect(next.release).toHaveBeenCalledTimes(1); expect(h.pool.decodedBytes()).toBe(0);
  });
  it('fits three distinct canonical atlases, shares duplicate pictures and preserves every action row', async () => {
    const decode = compactDecoder(), h = harness(decode), sources = sheetSources(6, 3);
    for (const source of sources) source.appearance.actionMappings.running = ['review'];
    sources[3].appearance.opacity = 0.5;
    h.pool.syncSources(sources); h.pool.demand(sources);
    for (let index = 0; index < h.requests.length; index++) { h.pool.accept(h.requests[index], png(1536, 1872)); await settle(); }
    expect(h.requests).toHaveLength(3); expect(decode).toHaveBeenCalledTimes(3);
    expect(h.pool.decodedBytes()).toBeLessThan(16 * 1024 * 1024); expect(sources.every(source => h.pool.status(source) === 'READY')).toBe(true);
    const visual = h.pool.visual(sources[0]), crop = visual.crop?.(sources[0], 0);
    expect(crop).toBeDefined(); expect(crop!.y + crop!.height).toBe(visual.height); expect(crop!.x + crop!.width).toBeLessThanOrEqual(visual.width!);
    expect(h.pool.visual(sources[3]).opacity).toBe(0.5); expect(h.pool.diagnostics()).toEqual({ images: 3, optimized: 3, loading: 0, fallback: 0 }); h.pool.dispose();
  });
  it('refits previously loaded art when a floor gains sixteen different Pets', async () => {
    const decode = compactDecoder(), h = harness(decode), sources = sheetSources(16);
    h.pool.syncSources(sources); h.pool.demand(sources.slice(0, 1)); h.pool.accept(h.requests[0], png(1536, 1872)); await settle();
    const first = (await decode.mock.results[0].value); expect(h.pool.decodedBytes()).toBe(1536 * 1872 * 4);
    h.pool.demand(sources); expect(first.release).toHaveBeenCalledOnce();
    for (let index = 1; index < h.requests.length; index++) { h.pool.accept(h.requests[index], png(1536, 1872)); await settle(); }
    expect(sources.every(source => h.pool.status(source) === 'READY')).toBe(true); expect(h.pool.decodedBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
    h.pool.dispose();
  });
  it('rejects a decoder that exceeds its admitted compact allocation and releases its result', async () => {
    const next = asset(2048, 2048), h = harness(vi.fn(async () => next)), sources = imageSources(1, 2048, 2048);
    h.pool.syncSources(sources); h.pool.demand(sources); h.pool.accept(h.requests[0], png(2048, 2048)); await settle();
    expect(h.pool.decodedBytes()).toBe(0); expect(h.pool.status(sources[0])).toBe('invalidImage'); expect(next.release).toHaveBeenCalledOnce(); h.pool.dispose();
  });
  it('rejects header and manifest mismatches before decoding', async () => {
    const h = harness(), sources = imageSources(1); h.pool.syncSources(sources); h.pool.demand(sources); h.pool.accept(h.requests[0], png(9, 8)); await settle();
    expect(h.decode).not.toHaveBeenCalled(); expect(h.pool.status(sources[0])).toBe('invalidImage'); h.pool.dispose();
  });
  it('reserves the background pixels within the same Pet decoding budget', async () => {
    const requests: AssetReference[] = [], decode = compactDecoder(); let backgroundBytes = 32 * 1024 * 1024;
    const pool = new OfficeLiveAssetPool({ request: value => requests.push(value), changed: () => {}, decode, externalDecodedBytes: () => backgroundBytes, decodedBudgetBytes: () => 32 * 1024 * 1024 });
    const sources = imageSources(1); pool.syncSources(sources); pool.demand(sources); pool.accept(requests[0], png()); await settle();
    expect(decode).not.toHaveBeenCalled(); expect(pool.decodedBytes()).toBe(0); expect(pool.status(sources[0])).toBe('decodeBudget');
    backgroundBytes = 16 * 1024 * 1024; pool.demand(sources); pool.accept(requests[1], png()); await settle();
    expect(pool.status(sources[0])).toBe('READY'); expect(pool.decodedBytes() + backgroundBytes).toBeLessThanOrEqual(32 * 1024 * 1024); pool.dispose();
  });
  it('releases off-floor images and allows a deliberate retry after a transfer failure', async () => {
    const next = asset(), h = harness(vi.fn(async () => next)), sources = imageSources(1); h.pool.syncSources(sources); h.pool.demand(sources);
    h.pool.result(h.requests[0].requestId, 'ASSET_RETRY'); expect(h.pool.status(sources[0])).toBe('ASSET_RETRY'); h.pool.retry(); expect(h.requests).toHaveLength(2);
    h.pool.accept(h.requests[1], png()); await settle(); h.pool.demand([]); expect(next.release).toHaveBeenCalledTimes(1); expect(h.pool.decodedBytes()).toBe(0); h.pool.dispose();
  });
});
