/** Only matching image content within this window is treated as a clipboard replay. */
export const IMAGE_PASTE_REPLAY_WINDOW_MS = 1000;

export type ImagePasteSource = 'dom-paste' | 'java-bridge';

export interface PastedImage {
  mediaType: string;
  data: string;
}

export interface ImagePasteDedupe {
  isNewPaste(image: PastedImage, source: ImagePasteSource, arrivedAt?: number): Promise<boolean>;
}

const MAX_COMPARISON_PIXELS = 16 * 1024 * 1024;
const IMAGE_DECODE_TIMEOUT_MS = 2000;
const MAX_RECENT_IMAGES = 16;

/** Compare rendered pixels rather than PNG metadata or the producer's encoding. */
export function getImagePixelFingerprint(image: PastedImage): Promise<string | null> {
  if (!globalThis.crypto?.subtle) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const decoded = new Image();
    const finish = (fingerprint: string | null) => {
      clearTimeout(timeout);
      decoded.onload = null;
      decoded.onerror = null;
      resolve(fingerprint);
    };
    // Unsupported clipboard formats must not hold up later attachments indefinitely.
    const timeout = setTimeout(() => finish(null), IMAGE_DECODE_TIMEOUT_MS);
    decoded.onerror = () => finish(null);
    decoded.onload = async () => {
      try {
        const width = decoded.naturalWidth;
        const height = decoded.naturalHeight;
        if (!width || !height || width * height > MAX_COMPARISON_PIXELS) {
          finish(null);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          finish(null);
          return;
        }
        context.drawImage(decoded, 0, 0);
        const pixels = context.getImageData(0, 0, width, height);
        const digest = await crypto.subtle.digest('SHA-256', pixels.data);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        finish(`${width}x${height}:${hash}`);
      } catch {
        // If equivalence cannot be established, keep the user's image.
        finish(null);
      }
    };
    decoded.src = `data:${image.mediaType};base64,${image.data}`;
  });
}

export function createImagePasteDedupe(
  windowMs: number = IMAGE_PASTE_REPLAY_WINDOW_MS,
  fingerprint: (image: PastedImage) => Promise<string | null> = getImagePixelFingerprint,
): ImagePasteDedupe {
  interface RecentImage {
    image: PastedImage;
    source: ImagePasteSource;
    sequence: number;
    encodings: Partial<Record<ImagePasteSource, PastedImage>>;
    lastSeenAt: number;
    fingerprint: Promise<string | null> | null;
  }
  let recentImages: RecentImage[] = [];
  const lastDeliveries: Partial<Record<ImagePasteSource, RecentImage>> = {};
  const observedGestures: Partial<Record<ImagePasteSource, number>> = {};
  let gestureSequence = 0;
  let pending = Promise.resolve(true);

  const safelyFingerprint = (image: PastedImage) =>
    Promise.resolve().then(() => fingerprint(image)).catch(() => null);

  return {
    isNewPaste(image, source, arrivedAt = Date.now()): Promise<boolean> {
      // Arrival time, not decoder completion time, defines the replay window.
      const now = arrivedAt;
      // Java encoding can finish after another paste; serialize decisions, not just the last image.
      pending = pending.then(async () => {
        recentImages = recentImages.filter((entry) => now - entry.lastSeenAt < windowMs);
        // A different accepted gesture invalidates old replay claims across both producers.
        // A producer that already accepted a newer image must not mistake its return to A for A's first echo.
        const canReplay = (entry: RecentImage) => (!entry.encodings[source] &&
          (lastDeliveries[source]?.sequence ?? 0) <= entry.sequence) ||
          (entry === lastDeliveries[source] && observedGestures[source] === gestureSequence);
        const identical = recentImages.find((entry) => canReplay(entry) &&
          Object.values(entry.encodings).some((encoding) =>
            encoding.mediaType === image.mediaType && encoding.data === image.data
          )
        );
        if (identical) {
          identical.lastSeenAt = now;
          identical.encodings[source] = image;
          lastDeliveries[source] = identical;
          observedGestures[source] = gestureSequence;
          return false;
        }

        let currentFingerprint: Promise<string | null> | null = null;
        const otherProducerImages = recentImages.filter((entry) => entry.source !== source && canReplay(entry));
        if (otherProducerImages.length > 0) {
          currentFingerprint = safelyFingerprint(image);
          const [current, ...previous] = await Promise.all([
            currentFingerprint,
            ...otherProducerImages.map((entry) => entry.fingerprint ??= safelyFingerprint(entry.image)),
          ]);
          const match = current === null ? undefined : otherProducerImages.find((_, index) =>
            previous[index] === current
          );
          if (match) {
            match.lastSeenAt = now;
            // Cache both encodings without turning an echo into the original paste's identity.
            match.encodings[source] = image;
            match.fingerprint = currentFingerprint;
            lastDeliveries[source] = match;
            observedGestures[source] = gestureSequence;
            return false;
          }
        }

        const accepted = { image, source, sequence: ++gestureSequence,
          encodings: { [source]: image }, lastSeenAt: now, fingerprint: currentFingerprint };
        lastDeliveries[source] = accepted;
        observedGestures[source] = gestureSequence;
        recentImages.push(accepted);
        // Retain only a bounded replay history, even under a burst of bridge events.
        if (recentImages.length > MAX_RECENT_IMAGES) {
          recentImages.shift();
        }
        return true;
      });
      return pending;
    },
  };
}
