import { describe, expect, it, vi } from 'vitest';
import { inspectOfficeImage, loadOfficeImage, OFFICE_IMAGE_MAX_BYTES, officeAssetVisual, planOfficeImageDecode } from './officeAssets';
import type { OfficeAsset } from './officeAssets';
import { createOfficeFixtures } from './officeModel';

function gif(width: number, height: number, count: number, frameWidth = 1): Uint8Array<ArrayBuffer> {
  const header = [71, 73, 70, 56, 57, 97, width & 255, width >> 8, height & 255, height >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  const frame = [0x2c, 0, 0, 0, 0, frameWidth & 255, frameWidth >> 8, 1, 0, 0, 2, 2, 0x44, 1, 0];
  return Uint8Array.from([...header, ...Array.from({ length: count }, () => frame).flat(), 0x3b]);
}

describe('Office appearance limits before native decoding', () => {
  it('compacts a complete atlas on cell boundaries and releases the compact bitmap', async () => {
    const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); const view = new DataView(bytes.buffer);
    view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12); view.setUint32(16, 1536); view.setUint32(20, 1872);
    const close = vi.fn(), bitmap = vi.fn(async (_source: unknown, options?: ImageBitmapOptions) => ({ width: options?.resizeWidth, height: options?.resizeHeight, close }));
    vi.stubGlobal('createImageBitmap', bitmap);
    try {
      const result = await loadOfficeImage(new File([bytes], 'atlas.png'), new AbortController().signal, { maxDecodedBytes: Math.floor(16 * 1024 * 1024 / 3) });
      expect(result.kind).toBe('sheet'); expect(result.width).toBe(result.cellWidth! * 8); expect(result.height).toBe(result.cellHeight! * 9);
      expect(result.cellWidth! / result.cellHeight!).toBe(192 / 208); expect(result.decodedBytes).toBeLessThan(16 * 1024 * 1024 / 3);
      const visual = officeAssetVisual(result), source = createOfficeFixtures(10)[0]; source.phase = 'WAITING_USER';
      const crop = visual?.crop?.(source, 0); expect(crop!.y + crop!.height).toBe(result.height); result.release(); expect(close).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps the full animation sequence within a compact allowance and rejects unusable allocations', () => {
    const header = inspectOfficeImage(gif(128, 128, 120), 'animated.gif');
    const plan = planOfficeImageDecode(header, { maxDecodedBytes: 1024 * 1024 });
    expect(plan.width * plan.height * 4 * 120).toBe(plan.decodedBytes); expect(plan.decodedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(() => planOfficeImageDecode(header, { maxDecodedBytes: 0 })).toThrow('decodeBudget');
    expect(() => planOfficeImageDecode(header, { maxDecodedBytes: 4 })).toThrow('decodeBudget');
  });
  it('compacts every decoded animation frame while retaining durations and closing native objects', async () => {
    const images = Array.from({ length: 3 }, () => ({ displayWidth: 512, displayHeight: 512, duration: 70_000, close: vi.fn() }));
    const decoderClose = vi.fn(), bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
    class Decoder {
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 3 } };
      decode = vi.fn(async ({ frameIndex }: { frameIndex: number }) => ({ image: images[frameIndex] }));
      close = decoderClose;
    }
    vi.stubGlobal('ImageDecoder', Decoder);
    vi.stubGlobal('createImageBitmap', vi.fn(async (_image: unknown, options: ImageBitmapOptions) => {
      const result = { width: options.resizeWidth!, height: options.resizeHeight!, close: vi.fn() }; bitmaps.push(result); return result;
    }));
    try {
      const result = await loadOfficeImage(new File([gif(512, 512, 3)], 'pet.gif'), new AbortController().signal, { maxDecodedBytes: 1024 * 1024 });
      expect(result.kind).toBe('animated'); expect(result.frames).toHaveLength(3); expect(result.durations).toEqual([70, 70, 70]);
      expect(result.width).toBe(208); expect(result.decodedBytes).toBe(208 * 208 * 4 * 3);
      expect(images.every(image => image.close.mock.calls.length === 1)).toBe(true); expect(decoderClose).toHaveBeenCalledOnce();
      result.release(); expect(bitmaps.every(image => image.close.mock.calls.length === 1)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects raw limits, false extensions, truncated GIFs and oversized frame rectangles', () => {
    expect(() => inspectOfficeImage(new Uint8Array(OFFICE_IMAGE_MAX_BYTES + 1), 'x.png')).toThrow('imageTooLarge');
    expect(() => inspectOfficeImage(gif(1, 1, 1), 'x.png')).toThrow('invalidImage');
    expect(() => inspectOfficeImage(gif(1, 1, 1).slice(0, 25), 'x.gif')).toThrow('invalidImage');
    expect(() => inspectOfficeImage(gif(16, 16, 1, 32), 'x.gif')).toThrow('invalidImage');
  });

  it('checks total animation pixels and frame count before constructing any decoder', () => {
    expect(inspectOfficeImage(gif(16, 16, 2), 'x.gif')).toMatchObject({ width: 16, height: 16, frameCount: 2 });
    expect(() => inspectOfficeImage(gif(16, 16, 241), 'x.gif')).toThrow('decodeBudget');
    expect(() => inspectOfficeImage(gif(2048, 2048, 3), 'x.gif')).toThrow('decodeBudget');
  });

  it('rejects repeated WebP canvas headers before native decoding', () => {
    const webp = Uint8Array.from(atob('UklGRoQAAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAA8AAA8AAFAAAAJWUDhMDwAAAC8PwAMABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAA8AAA8AAIwAAABWUDhMDwAAAC8PwAMABxDR//4HIqL/AQA='), char => char.charCodeAt(0));
    expect(inspectOfficeImage(webp, 'valid.webp').frameCount).toBe(2);
    const repeated = new Uint8Array(webp.length + 18);
    repeated.set(webp.subarray(0, 30));
    repeated.set(webp.subarray(12, 30), 30);
    repeated.set(webp.subarray(30), 48);
    new DataView(repeated.buffer).setUint32(4, repeated.length - 8, true);
    expect(() => inspectOfficeImage(repeated, 'repeated.webp')).toThrow('invalidImage');
  });

  it('rejects before allocating a native decoder or bitmap and honours pre-cancellation', async () => {
    const bitmap = vi.fn(); vi.stubGlobal('createImageBitmap', bitmap);
    try {
      const bytes = gif(2048, 2048, 3);
      const file = new File([bytes], 'too-many-pixels.gif');
      await expect(loadOfficeImage(file, new AbortController().signal)).rejects.toThrow('decodeBudget');
      const aborted = new AbortController(); aborted.abort();
      await expect(loadOfficeImage(file, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(bitmap).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('sharing decoded art keeps animation cursors source-specific', () => {
    const first = document.createElement('canvas'), second = document.createElement('canvas');
    const asset: OfficeAsset = { kind: 'animated', name: 'fixture', width: 1, height: 1, frames: [first, second], durations: [100, 100], decodedBytes: 8, release: () => {} };
    const visual = officeAssetVisual(asset);
    const sources = createOfficeFixtures(10);
    expect(visual?.frame(sources[0], 0)).toBe(first);
    expect(visual?.frame(sources[1], 0)).toBe(second);
    expect(visual?.frame(sources[0], 100)).toBe(second);
  });
});
