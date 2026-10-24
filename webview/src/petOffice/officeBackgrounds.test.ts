import { describe, expect, it, vi } from 'vitest';
import { OfficeBackgroundManager } from './officeBackgrounds';
import type { OfficeBackgroundState, OfficeBackgroundStorage } from './officeBackgrounds';
import type { OfficeAsset } from './officeAssets';

function png(width = 16, height = 16): File {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height);
  return new File([bytes], 'room.png', { type: 'image/png' });
}
function asset(width = 16, height = 16): OfficeAsset {
  return { kind: 'static', name: 'room', width, height, frames: [document.createElement('canvas')], durations: [], decodedBytes: width * height * 4, release: vi.fn() };
}
function harness(decode = vi.fn(async () => asset()), usedBytes = () => 0, decodedBudgetBytes = () => 32 * 1024 * 1024) {
  const files = new Map<number, File>();
  const storage: OfficeBackgroundStorage = { read: vi.fn(async floor => files.get(floor) ?? null),
    write: vi.fn(async (floor, file) => { files.set(floor, file); }), remove: vi.fn(async floor => { files.delete(floor); }), dispose: vi.fn() };
  let state: OfficeBackgroundState = { floor: -1, custom: false, busy: false, error: '' };
  const manager = new OfficeBackgroundManager({ storage, decode, usedBytes, decodedBudgetBytes, changed: value => { state = value; } });
  return { manager, files, storage, decode, state: () => state };
}
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

describe('floor backgrounds', () => {
  it('leaves default vector floors outside the raster decoder and releases a custom image on reset', async () => {
    const admitted = asset(), h = harness(vi.fn(async () => admitted), () => 50 * 1024 * 1024);
    h.manager.show(0); await settle();
    expect(h.state()).toMatchObject({ custom: false, busy: false, error: '' });
    expect(h.decode).not.toHaveBeenCalled(); expect(h.manager.decodedBytes()).toBe(0);
    h.manager.dispose();
    const custom = harness(vi.fn(async () => admitted));
    custom.manager.show(0); await settle(); custom.manager.import(png()); await settle();
    expect(custom.state().custom).toBe(true); expect(custom.manager.decodedBytes()).toBe(1024);
    custom.manager.reset(); await settle();
    expect(admitted.release).toHaveBeenCalledOnce(); expect(custom.state().custom).toBe(false);
    expect(custom.manager.visual()).toBeUndefined(); expect(custom.manager.decodedBytes()).toBe(0);
    expect(custom.decode).toHaveBeenCalledOnce(); custom.manager.dispose();
  });
  it('accounts for Pets within the configured 50 MiB aggregate budget', async () => {
    const h = harness(vi.fn(async () => asset()), () => 33 * 1024 * 1024, () => 50 * 1024 * 1024);
    h.manager.show(0); await settle(); h.manager.import(png()); await settle();
    expect(h.state()).toMatchObject({ custom: true, error: '' }); expect(h.manager.decodedBytes()).toBe(1024); h.manager.dispose();
  });
  it('preserves stored background files when a lower budget cannot admit them and restores them after raising it', async () => {
    let budget = 50 * 1024 * 1024;
    const decode = vi.fn(async () => asset(2048, 2048)), h = harness(decode, () => 0, () => budget);
    h.manager.show(0); await settle(); h.manager.import(png(2048, 2048)); await settle();
    const previous = await decode.mock.results[0].value; expect(h.state().custom).toBe(true);
    budget = 16 * 1024 * 1024; h.manager.reconfigureBudget(); await settle();
    expect(previous.release).toHaveBeenCalledOnce(); expect(h.manager.decodedBytes()).toBe(0); expect(h.state().error).toBe('backgroundBudget');
    expect(h.files.has(0)).toBe(true); expect(h.storage.remove).not.toHaveBeenCalled();
    budget = 50 * 1024 * 1024; h.manager.reconfigureBudget(); await settle();
    expect(h.state()).toMatchObject({ custom: true, error: '' }); expect(h.manager.decodedBytes()).toBe(16 * 1024 * 1024); h.manager.dispose();
  });
  it('saves separate floors and resets only the selected floor', async () => {
    const h = harness(); h.manager.show(0); await settle(); h.manager.import(png()); await settle();
    expect(h.state()).toMatchObject({ floor: 0, custom: true, busy: false, error: '' });
    h.manager.show(1); await settle(); expect(h.state().custom).toBe(false); h.manager.import(png()); await settle();
    h.manager.show(0); await settle(); expect(h.state().custom).toBe(true); h.manager.reset(); await settle();
    expect(h.files.has(0)).toBe(false); expect(h.files.has(1)).toBe(true); expect(h.manager.decodedBytes()).toBe(0);
    h.manager.show(1); await settle(); expect(h.state().custom).toBe(true); h.manager.dispose(); expect(h.storage.dispose).toHaveBeenCalledOnce();
  });
  it('keeps the admitted background when validation or storage fails', async () => {
    const admitted = asset(), h = harness(vi.fn(async () => admitted)); h.manager.show(0); await settle(); h.manager.import(png()); await settle();
    h.manager.import(new File(['invalid'], 'room.svg')); await settle(); expect(h.state().error).toBe('backgroundInvalid'); expect(admitted.release).not.toHaveBeenCalled();
    const replacement = asset(); h.decode.mockResolvedValueOnce(replacement); vi.mocked(h.storage.write).mockRejectedValueOnce(new Error('backgroundStorageFull'));
    h.manager.import(png()); await settle(); expect(h.state().error).toBe('backgroundStorageFull'); expect(replacement.release).toHaveBeenCalledOnce();
    expect(admitted.release).not.toHaveBeenCalled(); expect(h.state().custom).toBe(true); h.manager.dispose();
  });
  it('cannot apply a late floor read to a different floor', async () => {
    const h = harness(); let finish: ((file: File) => void) | undefined;
    vi.mocked(h.storage.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.manager.show(0); await settle(); h.manager.show(1); finish?.(png()); await settle();
    expect(h.decode).not.toHaveBeenCalled(); expect(h.state()).toMatchObject({ floor: 1, custom: false, busy: false }); h.manager.dispose();
  });
  it('releases a late noncancelable decode on floor change without saving it', async () => {
    const next = asset(); let finish: ((value: OfficeAsset) => void) | undefined;
    const h = harness(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    h.manager.show(0); await settle(); h.manager.import(png()); await settle(); expect(h.manager.decodedBytes()).toBe(1024);
    h.manager.show(1); finish?.(next); await settle(); expect(next.release).toHaveBeenCalledOnce();
    expect(h.storage.write).not.toHaveBeenCalled(); expect(h.manager.decodedBytes()).toBe(0); expect(h.state().floor).toBe(1); h.manager.dispose();
  });
  it('rejects file, pixel and aggregate Pet budgets before decoding', async () => {
    const h = harness(vi.fn(async () => asset()), () => 32 * 1024 * 1024); h.manager.show(0); await settle();
    h.manager.import(png()); await settle(); expect(h.state().error).toBe('backgroundBudget');
    h.manager.import(png(2560, 2048)); await settle(); expect(h.state().error).toBe('backgroundBudget');
    h.manager.import(new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'big.png')); await settle(); expect(h.state().error).toBe('backgroundTooLarge');
    expect(h.decode).not.toHaveBeenCalled(); expect(h.storage.write).not.toHaveBeenCalled(); h.manager.dispose();
  });
  it('retains replacement peak reservations until an in-flight decode is released after disposal', async () => {
    const next = asset(); let finish: ((value: OfficeAsset) => void) | undefined;
    const h = harness(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    h.manager.show(0); await settle(); h.manager.import(png()); await settle(); h.manager.dispose();
    expect(h.manager.decodedBytes()).toBe(1024); finish?.(next); await settle(); expect(next.release).toHaveBeenCalledOnce(); expect(h.manager.decodedBytes()).toBe(0);
    expect(h.storage.write).not.toHaveBeenCalled();
  });
});
