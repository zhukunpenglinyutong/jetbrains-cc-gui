import { paintOfficeRobot } from './officeRenderer';
import type { OfficePetVisual } from './officeRenderer';
import type { OfficePhase } from './officeModel';

export const OFFICE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const OFFICE_DECODE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 6_500_000;
const MAX_FRAMES = 240;

export interface OfficeAsset {
  kind: 'builtin' | 'sheet' | 'static' | 'animated';
  name: string;
  width: number;
  height: number;
  frames: readonly CanvasImageSource[];
  durations: readonly number[];
  decodedBytes: number;
  cellWidth?: number;
  cellHeight?: number;
  release: () => void;
}

export const BUILTIN_OFFICE_ASSET: OfficeAsset = {
  kind: 'builtin', name: 'builtin', width: 192, height: 208,
  frames: [], durations: [], decodedBytes: 0, release: () => {},
};

interface ImageHeader { mime: string; width: number; height: number; animated: boolean; frameCount?: number; transposed?: boolean }
export interface OfficeDecodeOptions { maxDecodedBytes: number }
export interface OfficeDecodePlan { width: number; height: number; decodedBytes: number; cellWidth?: number; cellHeight?: number }

/** Scale the entire atlas on cell boundaries; keep every action row and animation frame. */
export function planOfficeImageDecode(header: ImageHeader, options?: OfficeDecodeOptions): OfficeDecodePlan {
  const count = header.frameCount ?? 1;
  const sheet = !header.animated && !header.transposed && header.width === 1536 && header.height >= 1872 && header.height % 208 === 0;
  let width = header.transposed ? header.height : header.width, height = header.transposed ? header.width : header.height;
  let cellWidth: number | undefined, cellHeight: number | undefined;
  if (options) {
    if (!Number.isSafeInteger(options.maxDecodedBytes) || options.maxDecodedBytes < 4 || options.maxDecodedBytes > OFFICE_DECODE_MAX_BYTES) fail('decodeBudget');
    if (sheet) {
      const rows = header.height / 208;
      const units = Math.min(16, Math.floor(Math.sqrt(options.maxDecodedBytes / (8 * rows * 12 * 13 * 4))));
      if (units < 1) fail('decodeBudget');
      cellWidth = units * 12; cellHeight = units * 13; width = cellWidth * 8; height = cellHeight * rows;
    } else {
      const scale = Math.min(1, 208 / Math.max(width, height), Math.sqrt(options.maxDecodedBytes / (width * height * 4 * count)));
      width = Math.max(1, Math.floor(width * scale)); height = Math.max(1, Math.floor(height * scale));
    }
  }
  if (sheet && cellWidth === undefined) { cellWidth = 192; cellHeight = 208; }
  const decodedBytes = width * height * 4 * count;
  if (decodedBytes > (options?.maxDecodedBytes ?? OFFICE_DECODE_MAX_BYTES)) fail('decodeBudget');
  return { width, height, decodedBytes, cellWidth, cellHeight };
}
interface OfficeDecoder {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode: (options: { frameIndex: number }) => Promise<{ image: VideoFrame }>;
  close: () => void;
}
type OfficeDecoderConstructor = new (options: { data: Uint8Array; type: string; preferAnimation: boolean }) => OfficeDecoder;

function fail(code: string): never { throw new Error(code); }
function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Read only bounded IFD0 orientation; the native decoder still applies the actual EXIF transform. */
function jpegTransposed(bytes: Uint8Array, start: number, end: number): boolean {
  if (start + 14 > end || ascii(bytes, start, 6) !== 'Exif\0\0') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), base = start + 6;
  const order = view.getUint16(base), little = order === 0x4949;
  if ((!little && order !== 0x4d4d) || view.getUint16(base + 2, little) !== 42) return false;
  const directory = base + view.getUint32(base + 4, little);
  if (directory < base + 8 || directory + 2 > end) return false;
  const entries = view.getUint16(directory, little);
  if (entries > 256 || directory + 2 + entries * 12 > end) return false;
  for (let index = 0; index < entries; index++) {
    const entry = directory + 2 + index * 12;
    if (view.getUint16(entry, little) === 0x112 && view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1) {
      const orientation = view.getUint16(entry + 8, little); return orientation >= 5 && orientation <= 8;
    }
  }
  return false;
}

function checkFrames(header: ImageHeader, count: number): void {
  if (count < 1 || count > MAX_FRAMES || header.width * header.height * 4 * count > OFFICE_DECODE_MAX_BYTES) fail('decodeBudget');
}

/** GIF frame rectangles are checked before ImageDecoder allocates any frames. */
function inspectGifFrames(bytes: Uint8Array, header: ImageHeader): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let count = 0;
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (size === 0) return;
      offset += size;
      if (offset > bytes.length) fail('invalidImage');
    }
    fail('invalidImage');
  };
  while (offset < bytes.length) {
    const kind = bytes[offset++];
    if (kind === 0x3b) {
      checkFrames(header, count);
      return count;
    }
    if (kind === 0x21) {
      if (offset >= bytes.length) fail('invalidImage');
      offset += 1;
      skipBlocks();
    } else if (kind === 0x2c) {
      if (offset + 9 > bytes.length) fail('invalidImage');
      const left = view.getUint16(offset, true), top = view.getUint16(offset + 2, true);
      const width = view.getUint16(offset + 4, true), height = view.getUint16(offset + 6, true);
      if (!width || !height || left + width > header.width || top + height > header.height) fail('invalidImage');
      offset += 9 + ((bytes[offset + 8] & 0x80) ? 3 * (1 << ((bytes[offset + 8] & 7) + 1)) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) fail('invalidImage');
      offset += 1;
      skipBlocks();
      checkFrames(header, ++count);
    } else fail('invalidImage');
  }
  fail('invalidImage');
}

function inspectWebpFrames(bytes: Uint8Array, header: ImageHeader): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) fail('invalidImage');
  const u24 = (offset: number) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
  let count = 0;
  let animationHeader = false;
  const inspectChunks = (start: number, end: number, width: number, height: number, nested: boolean) => {
    let pixels = false;
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) fail('invalidImage');
      const kind = ascii(bytes, offset, 4), size = view.getUint32(offset + 4, true), data = offset + 8;
      const next = data + size + (size & 1);
      if (next > end) fail('invalidImage');
      if (kind === 'VP8X') {
        if (nested || offset !== 12 || size !== 10) fail('invalidImage');
      } else if (kind === 'ANIM') {
        if (nested || !header.animated || animationHeader || size !== 6) fail('invalidImage');
        animationHeader = true;
      } else if (kind === 'ANMF') {
        if (nested || !header.animated || !animationHeader || size < 16) fail('invalidImage');
        const x = u24(data) * 2, y = u24(data + 3) * 2;
        const w = u24(data + 6) + 1, h = u24(data + 9) + 1;
        if (x + w > width || y + h > height) fail('invalidImage');
        inspectChunks(data + 16, data + size, w, h, true);
        checkFrames(header, ++count);
      } else if (kind === 'VP8L' || kind === 'VP8 ') {
        let w = 0, h = 0;
        if (kind === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
          w = 1 + bytes[data + 1] + ((bytes[data + 2] & 63) << 8);
          h = 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 15) << 10);
        } else if (kind === 'VP8 ' && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 1 && bytes[data + 5] === 0x2a) {
          w = view.getUint16(data + 6, true) & 0x3fff;
          h = view.getUint16(data + 8, true) & 0x3fff;
        }
        if (pixels || w !== width || h !== height) fail('invalidImage');
        pixels = true;
      }
      offset = next;
    }
    if ((nested || !header.animated) && !pixels) fail('invalidImage');
  };
  inspectChunks(12, bytes.length, header.width, header.height, false);
  if (header.animated) checkFrames(header, count);
  return header.animated ? count : 1;
}

/** Inspect bounded headers before a native decoder can allocate image pixels. */
export function inspectOfficeImage(bytes: Uint8Array, name: string): ImageHeader {
  if (!bytes.length || bytes.length > OFFICE_IMAGE_MAX_BYTES) fail('imageTooLarge');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extension = name.toLowerCase().split('.').pop();
  let header: ImageHeader | null = null;
  if (extension === 'png' && bytes.length >= 33 && bytes[0] === 137 && ascii(bytes, 1, 7) === 'PNG\r\n\x1a\n'
    && view.getUint32(8) === 13 && ascii(bytes, 12, 4) === 'IHDR') {
    header = { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20), animated: false };
  } else if (extension === 'gif' && bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) {
    header = { mime: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true), animated: true };
  } else if (extension === 'webp' && bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    const u24 = (offset: number) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
    if (chunk === 'VP8X') {
      header = { mime: 'image/webp', width: 1 + u24(24), height: 1 + u24(27), animated: (bytes[20] & 2) !== 0 };
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      header = { mime: 'image/webp', width: 1 + bytes[21] + ((bytes[22] & 63) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10), animated: false };
    } else if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      header = { mime: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, animated: false };
    }
  } else if (['jpg', 'jpeg'].includes(extension ?? '') && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let transposed = false;
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xff || marker === 0x00 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker === 0xe1) transposed = jpegTransposed(bytes, offset + 2, offset + length);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
        header = { mime: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3), animated: false, transposed };
        break;
      }
      offset += length;
    }
  }
  if (!header || header.width < 1 || header.height < 1 || header.width > 4096 || header.height > 4096 || header.width * header.height > MAX_PIXELS) fail('invalidImage');
  if (header.width * header.height * 4 > OFFICE_DECODE_MAX_BYTES) fail('decodeBudget');
  if (header.mime === 'image/gif') header.frameCount = inspectGifFrames(bytes, header);
  if (header.mime === 'image/webp') header.frameCount = inspectWebpFrames(bytes, header);
  return header;
}

export async function loadOfficeImage(file: File, signal: AbortSignal, options?: OfficeDecodeOptions): Promise<OfficeAsset> {
  if (file.size > OFFICE_IMAGE_MAX_BYTES) fail('imageTooLarge');
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const header = inspectOfficeImage(bytes, file.name);
  const plan = planOfficeImageDecode(header, options);
  const resizing: ImageBitmapOptions | undefined = options ? { resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: 'high' } : undefined;
  const frames: ImageBitmap[] = [];
  const durations: number[] = [];
  let decoder: OfficeDecoder | null = null;
  const closeDecoder = () => { decoder?.close(); decoder = null; };
  try {
    if (header.animated) {
      const Decoder = (globalThis as unknown as { ImageDecoder?: OfficeDecoderConstructor }).ImageDecoder;
      if (!Decoder) fail('animationUnavailable');
      const activeDecoder = new Decoder({ data: bytes, type: header.mime, preferAnimation: true });
      decoder = activeDecoder;
      signal.addEventListener('abort', closeDecoder, { once: true });
      await activeDecoder.tracks.ready;
      signal.throwIfAborted();
      const count = activeDecoder.tracks.selectedTrack?.frameCount ?? 0;
      checkFrames(header, count);
      if (count !== header.frameCount) fail('invalidImage');
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        const { image } = await activeDecoder.decode({ frameIndex: index });
        try {
          signal.throwIfAborted();
          if (image.displayWidth !== header.width || image.displayHeight !== header.height) fail('invalidImage');
          frames.push(await createImageBitmap(image, resizing));
          durations.push(Math.max(20, (image.duration ?? 100_000) / 1000));
        } finally { image.close(); }
      }
    } else {
      frames.push(await createImageBitmap(new Blob([bytes], { type: header.mime }), resizing));
    }
    signal.throwIfAborted();
    if (frames.some(frame => options ? frame.width !== plan.width || frame.height !== plan.height
      : !((frame.width === header.width && frame.height === header.height)
      || (!header.animated && frame.width === header.height && frame.height === header.width)))) fail('invalidImage');
    // Browser EXIF orientation may transpose static dimensions without changing pixel cost.
    const width = frames[0].width, height = frames[0].height;
    const sheet = plan.cellWidth !== undefined && width === plan.width && height === plan.height;
    return {
      kind: sheet ? 'sheet' : header.animated ? 'animated' : 'static',
      name: file.name.slice(0, 160), width, height,
      frames, durations, decodedBytes: width * height * 4 * frames.length,
      cellWidth: sheet ? plan.cellWidth : undefined, cellHeight: sheet ? plan.cellHeight : undefined,
      release: () => frames.forEach(frame => frame.close()),
    };
  } catch (error) {
    frames.forEach(frame => frame.close());
    throw error;
  } finally {
    signal.removeEventListener('abort', closeDecoder);
    closeDecoder();
  }
}

/** Canonical sheet fixture uses the plugin's own robot at all nine action rows. */
export function createOfficeSheetFixture(): OfficeAsset {
  const canvas = document.createElement('canvas');
  canvas.width = 1536; canvas.height = 1872;
  const ctx = canvas.getContext('2d');
  if (!ctx) fail('invalidImage');
  const phases: readonly OfficePhase[] = ['QUEUED', 'RUNNING', 'THINKING', 'SUCCEEDED', 'FAILED', 'STOPPING', 'CANCELLED', 'UNKNOWN', 'WAITING_USER'];
  for (let row = 0; row < 9; row++) {
    for (let column = 0; column < 8; column++) {
      ctx.save(); ctx.translate(column * 192 + 96, row * 208 + 120); ctx.scale(2.2, 2.2);
      paintOfficeRobot(ctx, 0, 0, phases[row], column * 140, row);
      ctx.restore();
    }
  }
  return { kind: 'sheet', name: 'sheetFixture', width: canvas.width, height: canvas.height, frames: [canvas], durations: [], decodedBytes: canvas.width * canvas.height * 4, release: () => { canvas.width = 0; canvas.height = 0; } };
}

const SHEET_ROWS: Record<OfficePhase, number> = { IDLE: 0, QUEUED: 0, RUNNING: 1, THINKING: 2, SUCCEEDED: 3, FAILED: 4, STOPPING: 5, CANCELLED: 6, UNKNOWN: 7, WAITING_USER: 8 };

export function officeAssetVisual(asset: OfficeAsset): OfficePetVisual | undefined {
  if (asset.kind === 'builtin') return undefined;
  const totalDuration = asset.durations.reduce((sum, value) => sum + value, 0);
  return {
    width: asset.width, height: asset.height,
    frame: (source, time) => {
      if (asset.kind !== 'animated') return asset.frames[0];
      let elapsed = (time + source.seat * 113) % totalDuration;
      for (let index = 0; index < asset.frames.length; index++) {
        if (elapsed < asset.durations[index]) return asset.frames[index];
        elapsed -= asset.durations[index];
      }
      return asset.frames[0];
    },
    crop: asset.kind === 'sheet' ? (source, time) => ({ x: Math.floor(time / 140 + source.seat) % 8 * (asset.cellWidth ?? 192), y: SHEET_ROWS[source.phase] * (asset.cellHeight ?? 208), width: asset.cellWidth ?? 192, height: asset.cellHeight ?? 208 }) : undefined,
  };
}
