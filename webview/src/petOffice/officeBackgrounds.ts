import { inspectOfficeImage, loadOfficeImage } from './officeAssets';
import type { OfficeAsset } from './officeAssets';
import { officeBackgroundAllowance, resolveOfficeCacheBudget } from './officeCachePreferences';
import { OFFICE_MAX_FLOORS } from './officeModel';

export const OFFICE_BACKGROUND_DATABASE = 'ccgui-pet-office-backgrounds';
export const OFFICE_BACKGROUND_MAX_FLOORS = OFFICE_MAX_FLOORS;
export const OFFICE_BACKGROUND_STORAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS_BYTES = 16 * 1024 * 1024;

export interface OfficeBackgroundStorage {
  read: (floor: number) => Promise<File | null>;
  write: (floor: number, file: File) => Promise<void>;
  remove: (floor: number) => Promise<void>;
  dispose: () => void;
}

function validFloor(floor: number): void {
  if (!Number.isInteger(floor) || floor < 0 || floor >= OFFICE_BACKGROUND_MAX_FLOORS) throw new Error('backgroundStorageError');
}
function record(value: unknown): { floor: number; blob: Blob } {
  if (!value || typeof value !== 'object' || !('floor' in value) || !('blob' in value)
    || typeof value.floor !== 'number' || !(value.blob instanceof Blob) || Object.keys(value).length !== 2
    || !value.blob.size || value.blob.size > MAX_FILE_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(value.blob.type)) throw new Error('backgroundStorageError');
  validFloor(value.floor);
  return { floor: value.floor, blob: value.blob };
}

function completion<T>(transaction: IDBTransaction, value: () => T, error: () => string = () => 'backgroundStorageError'): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = () => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error(error())); } };
    const timer = setTimeout(() => { try { transaction.abort(); } catch { /* The transaction may have already finished. */ } fail(); }, 5000);
    transaction.oncomplete = () => { if (!finished) { finished = true; clearTimeout(timer); resolve(value()); } };
    transaction.onerror = transaction.onabort = fail;
  });
}

/** A dedicated, bounded IndexedDB store; no host paths or generic Java file operations. */
export class OfficeBackgroundStore implements OfficeBackgroundStorage {
  private database: Promise<IDBDatabase> | null = null;
  private closed = false;

  private open(): Promise<IDBDatabase> {
    if (this.closed || typeof indexedDB === 'undefined') return Promise.reject(new Error('backgroundStorageError'));
    if (this.database) return this.database;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(OFFICE_BACKGROUND_DATABASE, 1);
      let finished = false;
      const fail = () => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error('backgroundStorageError')); } };
      const timer = setTimeout(fail, 5000);
      request.onupgradeneeded = () => request.result.createObjectStore('floors', { keyPath: 'floor' });
      request.onerror = fail; request.onblocked = fail;
      request.onsuccess = () => {
        if (finished || this.closed) { request.result.close(); fail(); return; }
        finished = true; clearTimeout(timer);
        request.result.onversionchange = () => { request.result.close(); this.database = null; };
        resolve(request.result);
      };
    });
    this.database = opening;
    void opening.catch(() => { if (this.database === opening) this.database = null; });
    return opening;
  }

  async read(floor: number): Promise<File | null> {
    validFloor(floor);
    const database = await this.open();
    const transaction = database.transaction('floors', 'readonly');
      const request = transaction.objectStore('floors').get(floor);
      let result: File | null = null;
      request.onsuccess = () => {
        try {
          const value: unknown = request.result;
          if (value !== undefined) {
            const saved = record(value);
            if (saved.floor !== floor) throw new Error('backgroundStorageError');
            result = new File([saved.blob], `background.${saved.blob.type === 'image/jpeg' ? 'jpg' : saved.blob.type === 'image/png' ? 'png' : 'webp'}`, { type: saved.blob.type });
          }
        } catch { transaction.abort(); }
      };
    return completion(transaction, () => result);
  }

  async write(floor: number, file: File): Promise<void> {
    validFloor(floor);
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('backgroundTooLarge');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('backgroundInvalid');
    const database = await this.open();
    const transaction = database.transaction('floors', 'readwrite'), store = transaction.objectStore('floors');
      const request = store.getAll(undefined, OFFICE_BACKGROUND_MAX_FLOORS + 1);
      let error = 'backgroundStorageError';
      request.onsuccess = () => {
        try {
          const values: unknown = request.result;
          if (!Array.isArray(values) || values.length > OFFICE_BACKGROUND_MAX_FLOORS) throw new Error(error);
          let bytes = file.size;
          for (const value of values) { const saved = record(value); if (saved.floor !== floor) bytes += saved.blob.size; }
          if (bytes > OFFICE_BACKGROUND_STORAGE_BYTES) { error = 'backgroundStorageFull'; throw new Error(error); }
          store.put({ floor, blob: new Blob([file], { type: file.type }) });
        } catch { transaction.abort(); }
      };
    return completion(transaction, () => undefined, () => error);
  }

  async remove(floor: number): Promise<void> {
    validFloor(floor);
    const database = await this.open();
    const transaction = database.transaction('floors', 'readwrite');
      transaction.objectStore('floors').delete(floor);
    return completion(transaction, () => undefined);
  }

  dispose(): void { this.closed = true; if (this.database) void this.database.then(database => database.close(), () => undefined); }
}

export interface OfficeBackgroundState { floor: number; custom: boolean; busy: boolean; error: string }
interface BackgroundOptions {
  storage?: OfficeBackgroundStorage;
  decode?: typeof loadOfficeImage;
  usedBytes: () => number;
  changed: (state: OfficeBackgroundState) => void;
  decodedBudgetBytes?: () => number;
}

/** Only the current floor is decoded. Generations fence late reads, decodes and writes. */
export class OfficeBackgroundManager {
  private readonly storage: OfficeBackgroundStorage;
  private readonly decode: typeof loadOfficeImage;
  private readonly options: BackgroundOptions;
  private asset: OfficeAsset | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private reserved = 0;
  private closed = false;
  private state: OfficeBackgroundState = { floor: -1, custom: false, busy: false, error: '' };
  private chain: Promise<void> = Promise.resolve();

  constructor(options: BackgroundOptions) { this.options = options; this.storage = options.storage ?? new OfficeBackgroundStore(); this.decode = options.decode ?? loadOfficeImage; }
  decodedBytes(): number { return (this.asset?.decodedBytes ?? 0) + this.reserved; }
  image(): CanvasImageSource | null { return this.asset?.frames[0] ?? null; }
  visual(): { image: CanvasImageSource; width: number; height: number } | undefined {
    return this.asset ? { image: this.asset.frames[0], width: this.asset.width, height: this.asset.height } : undefined;
  }
  private emit(): void { if (!this.closed) this.options.changed({ ...this.state }); }

  reconfigureBudget(): void { if (!this.closed && this.state.floor >= 0) this.show(this.state.floor); }

  show(floor: number): void {
    if (this.closed) return;
    validFloor(floor);
    this.controller?.abort(); this.asset?.release(); this.asset = null;
    this.state = { floor, custom: false, busy: true, error: '' };
    const generation = ++this.generation;
    this.emit();
    this.enqueue(generation, async () => {
      const file = await this.storage.read(floor);
      if (generation !== this.generation || this.closed) return;
      if (file) await this.load(file, generation, false);
    });
  }

  import(file: File): void {
    if (this.closed || this.state.floor < 0 || this.state.busy) return;
    this.state = { ...this.state, busy: true, error: '' };
    const generation = ++this.generation;
    this.emit(); this.enqueue(generation, () => this.load(file, generation, true));
  }

  reset(): void {
    if (this.closed || this.state.floor < 0 || this.state.busy) return;
    this.state = { ...this.state, busy: true, error: '' };
    const generation = ++this.generation, floor = this.state.floor;
    this.emit(); this.enqueue(generation, async () => {
      await this.storage.remove(floor);
      if (generation === this.generation && !this.closed) { this.asset?.release(); this.asset = null; this.state.custom = false; }
    });
  }

  private enqueue(generation: number, action: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.closed || generation !== this.generation) return;
      try { await action(); }
      catch (error) {
        if (!this.closed && generation === this.generation) {
          const reason = error instanceof Error ? error.message : '';
          this.state.error = ['backgroundTooLarge', 'backgroundInvalid', 'backgroundBudget', 'backgroundStorageError', 'backgroundStorageFull'].includes(reason)
            ? reason : reason === 'invalidImage' ? 'backgroundInvalid' : reason === 'decodeBudget' ? 'backgroundBudget' : 'backgroundImageError';
        }
      }
      finally { if (!this.closed && generation === this.generation) { this.state.busy = false; this.emit(); } }
    });
  }

  private async load(file: File, generation: number, save: boolean): Promise<void> {
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('backgroundTooLarge');
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('backgroundInvalid');
    const header = inspectOfficeImage(new Uint8Array(await file.arrayBuffer()), file.name);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(header.mime) || header.animated || (header.frameCount ?? 1) !== 1) throw new Error('backgroundInvalid');
    const cost = header.width * header.height * 4;
    const budget = resolveOfficeCacheBudget(this.options.decodedBudgetBytes?.());
    if (cost > Math.min(MAX_PIXELS_BYTES, officeBackgroundAllowance(budget)) || cost + this.decodedBytes() + this.options.usedBytes() > budget) throw new Error('backgroundBudget');
    if (this.closed || generation !== this.generation) return;
    const floor = this.state.floor, controller = new AbortController(); this.controller = controller; this.reserved = cost;
    let next: OfficeAsset | null = null;
    try {
      next = await this.decode(file, controller.signal);
      if (next.kind === 'animated' || next.decodedBytes > cost || !((next.width === header.width && next.height === header.height)
        || (next.width === header.height && next.height === header.width))) throw new Error('backgroundInvalid');
      if (this.closed || generation !== this.generation) return;
      if (save) await this.storage.write(floor, new File([file], `background.${header.mime === 'image/jpeg' ? 'jpg' : header.mime === 'image/png' ? 'png' : 'webp'}`, { type: header.mime }));
      if (this.closed || generation !== this.generation) return;
      this.asset?.release(); this.asset = next; next = null; this.state.custom = true;
    } finally { next?.release(); this.reserved = 0; if (this.controller === controller) this.controller = null; }
  }

  dispose(): void { this.closed = true; this.generation++; this.controller?.abort(); this.asset?.release(); this.asset = null; this.storage.dispose(); }
}
