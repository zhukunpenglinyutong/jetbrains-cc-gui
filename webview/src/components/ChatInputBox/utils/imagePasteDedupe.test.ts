import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PASTE_REPLAY_WINDOW_MS,
  createImagePasteDedupe,
  getImagePixelFingerprint,
} from './imagePasteDedupe.js';

const image = { mediaType: 'image/png', data: 'AAAA' };
const otherImage = { mediaType: 'image/png', data: 'BBBB' };
const reencodedImage = { mediaType: 'image/png', data: 'REENCODED' };

function createDedupe() {
  const fingerprint = vi.fn(async ({ data }: { data: string }) =>
    data === 'REENCODED' ? image.data : data
  );
  return { dedupe: createImagePasteDedupe(undefined, fingerprint), fingerprint };
}

describe('createImagePasteDedupe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts the first image without decoding it', async () => {
    const { dedupe, fingerprint } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it('drops identical bytes from either producer without decoding', async () => {
    const { dedupe, fingerprint } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(false);
    expect(await dedupe.isNewPaste(image, 'java-bridge')).toBe(false);
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it.each(['dom-paste', 'java-bridge'] as const)(
    'drops a re-encoded copy when %s arrives first',
    async (source) => {
      const { dedupe } = createDedupe();
      const otherSource = source === 'dom-paste' ? 'java-bridge' : 'dom-paste';

      expect(await dedupe.isNewPaste(image, source)).toBe(true);
      expect(await dedupe.isNewPaste(reencodedImage, otherSource)).toBe(false);
    },
  );

  it.each(['dom-paste', 'java-bridge'] as const)(
    'accepts a different image from the other producer after %s',
    async (source) => {
      const { dedupe } = createDedupe();
      const otherSource = source === 'dom-paste' ? 'java-bridge' : 'dom-paste';

      expect(await dedupe.isNewPaste(image, source)).toBe(true);
      vi.advanceTimersByTime(500);
      expect(await dedupe.isNewPaste(otherImage, otherSource)).toBe(true);
    },
  );

  it('does not decode different images from the same producer', async () => {
    const { dedupe, fingerprint } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it('keeps matching echoes inside the replay window', async () => {
    const { dedupe } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    vi.advanceTimersByTime(900);
    expect(await dedupe.isNewPaste(image, 'java-bridge')).toBe(false);
    vi.advanceTimersByTime(800);
    expect(await dedupe.isNewPaste(image, 'java-bridge')).toBe(false);
    vi.advanceTimersByTime(IMAGE_PASTE_REPLAY_WINDOW_MS);
    expect(await dedupe.isNewPaste(image, 'java-bridge')).toBe(true);
  });

  it('does not compare images after their replay window expires', async () => {
    const { dedupe, fingerprint } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    vi.advanceTimersByTime(IMAGE_PASTE_REPLAY_WINDOW_MS);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(true);
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it('collapses a delayed echo even after a different image was attached', async () => {
    const { dedupe } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(await dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
    vi.advanceTimersByTime(300);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(false);
  });

  it('keeps a deliberate A/B/A sequence from the same producer', async () => {
    const { dedupe } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
  });

  it('keeps deliberate A/B/A when a delayed echo of A arrives between B and the final A', async () => {
    const { dedupe } = createDedupe();
    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(false);
    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(false);
  });

  it('keeps a deliberate A/B/A sequence after the first image crossed producers', async () => {
    const { dedupe } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(image, 'java-bridge')).toBe(false);
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(true);
    expect(await dedupe.isNewPaste(image, 'java-bridge')).toBe(true);
  });

  it.each(['dom-paste', 'java-bridge'] as const)(
    'keeps deliberate %s A/B/A after an identical echo from the other producer',
    async (source) => {
      const { dedupe } = createDedupe();
      const otherSource = source === 'dom-paste' ? 'java-bridge' : 'dom-paste';

      expect(await dedupe.isNewPaste(image, source)).toBe(true);
      expect(await dedupe.isNewPaste(image, otherSource)).toBe(false);
      expect(await dedupe.isNewPaste(otherImage, source)).toBe(true);
      expect(await dedupe.isNewPaste(image, source)).toBe(true);
    },
  );

  it.each(['dom-paste', 'java-bridge'] as const)(
    'keeps deliberate %s A/B/A after a re-encoded echo from the other producer',
    async (source) => {
      const { dedupe } = createDedupe();
      const otherSource = source === 'dom-paste' ? 'java-bridge' : 'dom-paste';

      expect(await dedupe.isNewPaste(image, source)).toBe(true);
      expect(await dedupe.isNewPaste(reencodedImage, otherSource)).toBe(false);
      expect(await dedupe.isNewPaste(otherImage, source)).toBe(true);
      expect(await dedupe.isNewPaste(image, source)).toBe(true);
    },
  );

  it('reuses both producer encodings when the most recent image keeps echoing', async () => {
    const { dedupe, fingerprint } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(false);
    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(false);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(false);
    expect(fingerprint).toHaveBeenCalledTimes(2);
  });

  it.each(['dom-paste', 'java-bridge'] as const)(
    'keeps %s A/B/A when only the other producer delivered B',
    async (source) => {
      for (const echo of [image, reencodedImage]) {
        const { dedupe } = createDedupe();
        const otherSource = source === 'dom-paste' ? 'java-bridge' : 'dom-paste';
        expect(await dedupe.isNewPaste(image, source, 0)).toBe(true);
        expect(await dedupe.isNewPaste(echo, otherSource, 100)).toBe(false);
        expect(await dedupe.isNewPaste(otherImage, otherSource, 400)).toBe(true);
        expect(await dedupe.isNewPaste(image, source, 700)).toBe(true);
        expect(await dedupe.isNewPaste(image, otherSource, 800)).toBe(false);
      }
    },
  );

  it('collapses repeated delayed echoes after a different image was attached', async () => {
    const { dedupe } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(false);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(false);
  });

  it.each(['dom-paste', 'java-bridge'] as const)(
    'keeps A/B/A after %s A without requiring an initial echo',
    async (source) => {
      for (const finalImage of [image, reencodedImage]) {
        const { dedupe } = createDedupe();
        const otherSource = source === 'dom-paste' ? 'java-bridge' : 'dom-paste';
        expect(await dedupe.isNewPaste(image, source, 0)).toBe(true);
        expect(await dedupe.isNewPaste(otherImage, otherSource, 400)).toBe(true);
        expect(await dedupe.isNewPaste(finalImage, otherSource, 800)).toBe(true);
      }
    },
  );

  it('does not extend unrelated images when one image keeps echoing', async () => {
    const { dedupe } = createDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
    vi.advanceTimersByTime(900);
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(false);
    vi.advanceTimersByTime(200);
    expect(await dedupe.isNewPaste(image, 'java-bridge')).toBe(true);
  });

  it('serializes simultaneous echoes and reuses their latest encoding', async () => {
    const { dedupe, fingerprint } = createDedupe();

    const decisions = await Promise.all([
      dedupe.isNewPaste(image, 'dom-paste'),
      dedupe.isNewPaste(reencodedImage, 'java-bridge'),
      dedupe.isNewPaste(reencodedImage, 'java-bridge'),
    ]);

    expect(decisions).toEqual([true, false, false]);
    expect(fingerprint).toHaveBeenCalledTimes(2);
  });

  it('uses arrival time even when decoding finishes outside the replay window', async () => {
    let resolveFingerprint!: (value: string) => void;
    const decoded = new Promise<string>((resolve) => { resolveFingerprint = resolve; });
    const dedupe = createImagePasteDedupe(undefined, () => decoded);

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    const echo = dedupe.isNewPaste(reencodedImage, 'java-bridge');
    vi.advanceTimersByTime(2000);
    resolveFingerprint('same-pixels');
    expect(await echo).toBe(false);
    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
  });

  it('keeps images when neither decoder can establish equivalence', async () => {
    const dedupe = createImagePasteDedupe(undefined, async () => null);

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(true);
  });

  it('keeps images when only one decoder succeeds', async () => {
    const dedupe = createImagePasteDedupe(undefined, async ({ data }) =>
      data === image.data ? 'pixels' : null
    );

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(true);
  });

  it('recovers from a failed decoder and still handles later pastes', async () => {
    const dedupe = createImagePasteDedupe(undefined, async () => { throw new Error('decode failed'); });

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(false);
  });

  it('bounds the replay history under a burst of distinct bridge images', async () => {
    const { dedupe } = createDedupe();

    for (let index = 0; index < 17; index++) {
      expect(await dedupe.isNewPaste({ ...image, data: String(index) }, 'java-bridge')).toBe(true);
    }
    expect(await dedupe.isNewPaste({ ...image, data: '0' }, 'java-bridge')).toBe(true);
  });
});

function stubDecodedImage(pixels = new Uint8ClampedArray([255, 0, 0, 255]), width = 1, height = 1) {
  class DecodedImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', DecodedImage);
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: pixels })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  return context;
}

describe('getImagePixelFingerprint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', webcrypto);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('matches pixels across different formats and encoded payloads', async () => {
    const context = stubDecodedImage();

    const original = await getImagePixelFingerprint({ mediaType: 'image/jpeg', data: 'RAW' });
    const reencoded = await getImagePixelFingerprint(reencodedImage);

    expect(original).toMatch(/^1x1:[a-f0-9]{64}$/);
    expect(reencoded).toBe(original);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes even a one-channel pixel change', async () => {
    const context = stubDecodedImage();
    const original = await getImagePixelFingerprint(image);
    context.getImageData.mockReturnValue({ data: new Uint8ClampedArray([254, 0, 0, 255]) });

    expect(await getImagePixelFingerprint(otherImage)).not.toBe(original);
  });

  it('includes dimensions instead of comparing equal flattened pixel data alone', async () => {
    stubDecodedImage(new Uint8ClampedArray(8), 2, 1);
    const original = await getImagePixelFingerprint(image);
    stubDecodedImage(new Uint8ClampedArray(8), 1, 2);

    expect(await getImagePixelFingerprint(otherImage)).not.toBe(original);
  });

  it('falls back when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);

    expect(await getImagePixelFingerprint(image)).toBeNull();
  });

  it('avoids allocating a canvas for oversized images', async () => {
    const context = stubDecodedImage(new Uint8ClampedArray(0), 8192, 8192);

    expect(await getImagePixelFingerprint(image)).toBeNull();
    expect(context.drawImage).not.toHaveBeenCalled();
  });

  it('falls back for images without valid dimensions', async () => {
    stubDecodedImage(new Uint8ClampedArray(0), 0, 0);

    expect(await getImagePixelFingerprint(image)).toBeNull();
  });

  it('falls back when a canvas context cannot be obtained', async () => {
    stubDecodedImage();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);

    expect(await getImagePixelFingerprint(image)).toBeNull();
  });

  it('falls back when pixel extraction fails', async () => {
    const context = stubDecodedImage();
    context.getImageData.mockImplementation(() => { throw new Error('canvas unavailable'); });

    expect(await getImagePixelFingerprint(image)).toBeNull();
  });

  it('falls back when hashing fails', async () => {
    stubDecodedImage();
    vi.spyOn(webcrypto.subtle, 'digest').mockRejectedValue(new Error('hash failed'));

    expect(await getImagePixelFingerprint(image)).toBeNull();
  });

  it('releases image event handlers when decoding fails', async () => {
    let decoded!: HTMLImageElement;
    vi.stubGlobal('Image', class {
      constructor() { decoded = this as unknown as HTMLImageElement; }
      set src(_value: string) { queueMicrotask(() => decoded.onerror?.(new Event('error'))); }
    });

    expect(await getImagePixelFingerprint(image)).toBeNull();
    expect(decoded.onload).toBeNull();
    expect(decoded.onerror).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses decoded pixels to drop re-encoded echoes but keep a different image', async () => {
    const context = stubDecodedImage();
    const dedupe = createImagePasteDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(await dedupe.isNewPaste(reencodedImage, 'java-bridge')).toBe(false);
    context.getImageData.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 255, 255]) });
    expect(await dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
  });

  it('unblocks the paste queue after an unresponsive image decoder times out', async () => {
    vi.stubGlobal('Image', class {});
    const dedupe = createImagePasteDedupe();

    expect(await dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    const secondPaste = dedupe.isNewPaste(otherImage, 'java-bridge');
    await vi.advanceTimersByTimeAsync(2000);

    expect(await secondPaste).toBe(true);
    // The timed-out paste arrived two seconds ago, so a deliberate paste is new.
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(true);
    expect(await dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a decoder that never reports success or failure', async () => {
    vi.stubGlobal('Image', class {});
    const fingerprint = getImagePixelFingerprint(image);

    await vi.advanceTimersByTimeAsync(2000);

    expect(await fingerprint).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
