import { sendOfficeRequest } from './officeBridge';
import { digest, integer, keys, object, text } from './officeLiveModel';
import { validOfficeCacheLimit } from './officeCachePreferences';
import { normalizeOfficeThemeFloors } from './officeThemes';
import { OFFICE_MAX_FLOORS } from './officeModel';
import type { OfficeThemeId } from './officeThemes';
import type { OfficeBackgroundStorage } from './officeBackgrounds';
import { OFFICE_PRESENTATION_DEFAULTS, parseOfficePresentation } from './officePresentation';
import type { OfficePresentationPreferences } from './officePresentation';
import { parseOfficeAppearanceOverrides, parseOfficePetChoices } from './officeAppearanceOverrides';
import type { OfficeAppearanceOverrides } from './officeAppearanceOverrides';
import { parseOfficeName } from './officeName';

export interface OfficeSharedPreferences {
  officeName: string; limitMiB: number; floors: OfficeThemeId[]; floor: number; product: string; search: string;
  showIdle: boolean; paused: boolean; topmost: boolean; zoom: number; presentation: OfficePresentationPreferences; appearanceOverrides: OfficeAppearanceOverrides;
}
export interface OfficeSharedState {
  schemaVersion: 1; revision: string; preferences: OfficeSharedPreferences;
  bounds: { x: number; y: number; width: number; height: number; placed: boolean };
}
export type OfficeStorageOperation = 'petChoices' | 'preferences' | 'backgroundRead' | 'backgroundBegin' | 'backgroundChunk' | 'backgroundCommit' | 'backgroundRemove';

export function parseOfficeSharedState(raw: unknown): OfficeSharedState {
  const value = object(raw); keys(value, ['schemaVersion', 'revision', 'preferences', 'bounds']);
  if (value.schemaVersion !== 1 || !/^(initial|[a-f0-9-]{36})$/.test(text(value.revision, 64))) throw new Error('sharedPreferencesError');
  const p = object(value.preferences);
  keys(p, ['limitMiB', 'floors', 'floor', 'product', 'search', 'showIdle', 'paused', 'topmost', 'zoom', ...('presentation' in p ? ['presentation'] : []), ...('appearanceOverrides' in p ? ['appearanceOverrides'] : []), ...('officeName' in p ? ['officeName'] : [])]);
  const officeName = 'officeName' in p ? parseOfficeName(p.officeName) : '';
  const presentation = 'presentation' in p ? parseOfficePresentation(p.presentation) : { ...OFFICE_PRESENTATION_DEFAULTS };
  const appearanceOverrides = 'appearanceOverrides' in p ? parseOfficeAppearanceOverrides(p.appearanceOverrides) : {};
  const floors = normalizeOfficeThemeFloors(p.floors);
  if (!validOfficeCacheLimit(p.limitMiB)
    || typeof p.showIdle !== 'boolean' || typeof p.paused !== 'boolean' || typeof p.topmost !== 'boolean'
    || integer(p.zoom, 150) < 75) throw new Error('sharedPreferencesError');
  const b = object(value.bounds); keys(b, ['x', 'y', 'width', 'height', 'placed']);
  for (const name of ['x', 'y'] as const) if (typeof b[name] !== 'number' || !Number.isSafeInteger(b[name]) || Math.abs(b[name]) > 32768) throw new Error('sharedPreferencesError');
  if (integer(b.width, 7680) < 320 || integer(b.height, 4320) < 320 || typeof b.placed !== 'boolean') throw new Error('sharedPreferencesError');
  return { schemaVersion: 1, revision: value.revision as string,
    preferences: { officeName, limitMiB: p.limitMiB, floors, floor: integer(p.floor, OFFICE_MAX_FLOORS - 1), product: text(p.product, 160), search: text(p.search, 160),
      showIdle: p.showIdle, paused: p.paused, topmost: p.topmost, zoom: p.zoom as number, presentation, appearanceOverrides },
    bounds: { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number, placed: b.placed } };
}

export class OfficeStorageError extends Error {
  readonly state: unknown;
  constructor(code: string, state?: unknown) { super(code); this.state = state; }
}

interface PendingStorage {
  operation: OfficeStorageOperation; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  transfer?: { bytes: Uint8Array; mime: string; digest: string; next: number; offset: number; committing: boolean };
}

/** Bounded, page-fenced JCEF storage. Never accepts an arbitrary host path or executable command. */
export class OfficeNativeStorage implements OfficeBackgroundStorage {
  private readonly page: string;
  private readonly send: typeof sendOfficeRequest;
  private readonly pending = new Map<string, PendingStorage>();
  private closed = false;
  private readonly receiver = (raw: unknown) => { void this.receive(raw); };
  constructor(page = window.__PET_OFFICE_BOOTSTRAP__?.pageGeneration ?? '', send = sendOfficeRequest) {
    this.page = page; this.send = send;
    window.petOfficeStorageResult = this.receiver;
  }

  request(operation: OfficeStorageOperation, payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.pending.size >= 2) return Promise.reject(new OfficeStorageError('OFFICE_STORAGE_BUSY'));
    const encoded = JSON.stringify(payload);
    if (encoded.length > 44000) return Promise.reject(new OfficeStorageError('OFFICE_STORAGE_INVALID'));
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new OfficeStorageError('OFFICE_STORAGE_TIMEOUT')); }, 15000);
      this.pending.set(requestId, { operation, resolve, reject, timer });
      try { this.send('storage', { requestId, operation, payload: encoded }); }
      catch { this.finish(requestId, undefined, new OfficeStorageError('OFFICE_STORAGE_INVALID')); }
    });
  }

  private finish(id: string, value?: unknown, error?: Error): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private async receive(raw: unknown): Promise<void> {
    if (this.closed) return;
    let id = '';
    try {
      const value = object(raw);
      if (value.pageGeneration !== this.page) return;
      id = text(value.requestId, 64);
      const pending = this.pending.get(id); if (!pending) return;
      if (JSON.stringify(value).length > 65536) throw new Error('invalidStorage');
      switch (value.type) {
        case 'error':
          keys(value, value.state === undefined ? ['requestId', 'type', 'pageGeneration', 'code'] : ['requestId', 'type', 'pageGeneration', 'code', 'state']);
          this.finish(id, undefined, new OfficeStorageError(/^OFFICE_[A-Z_]{1,56}$/.test(text(value.code, 64)) ? value.code as string : 'OFFICE_STORAGE_INVALID', value.state)); return;
        case 'value':
          if (pending.transfer) throw new Error('invalidStorage');
          if (pending.operation === 'preferences') {
            keys(value, ['requestId', 'type', 'pageGeneration', 'state']); this.finish(id, parseOfficeSharedState(value.state));
          } else if (pending.operation === 'petChoices') {
            keys(value, ['requestId', 'type', 'pageGeneration', 'choices']); this.finish(id, parseOfficePetChoices(value.choices));
          } else if (pending.operation === 'backgroundRead') {
            keys(value, ['requestId', 'type', 'pageGeneration', 'empty']); if (value.empty !== true) throw new Error('invalidStorage'); this.finish(id, null);
          } else { keys(value, ['requestId', 'type', 'pageGeneration']); this.finish(id); }
          return;
        case 'begin': {
          keys(value, ['requestId', 'type', 'pageGeneration', 'byteLength', 'mime', 'digest']);
          const length = integer(value.byteLength, 4 * 1024 * 1024), mime = text(value.mime, 32);
          if (pending.operation !== 'backgroundRead' || pending.transfer || !length || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('invalidStorage');
          pending.transfer = { bytes: new Uint8Array(length), mime, digest: digest(value.digest), next: 0, offset: 0, committing: false }; return;
        }
        case 'chunk': {
          keys(value, ['requestId', 'type', 'pageGeneration', 'index', 'data']);
          const transfer = pending.transfer;
          if (!transfer || transfer.committing || integer(value.index, 127) !== transfer.next) throw new Error('invalidStorage');
          const encoded = text(value.data, 44000), decoded = atob(encoded);
          if (btoa(decoded) !== encoded || decoded.length !== Math.min(32768, transfer.bytes.length - transfer.offset) || !decoded.length) throw new Error('invalidStorage');
          transfer.bytes.set(Uint8Array.from(decoded, char => char.charCodeAt(0)), transfer.offset); transfer.offset += decoded.length; transfer.next++; return;
        }
        case 'commit': {
          keys(value, ['requestId', 'type', 'pageGeneration']);
          const transfer = pending.transfer;
          if (!transfer || transfer.committing || transfer.offset !== transfer.bytes.length) throw new Error('invalidStorage');
          transfer.committing = true;
          const hash = await sha256(transfer.bytes);
          if (hash !== transfer.digest) throw new Error('invalidStorage');
          if (!this.closed && this.pending.get(id) === pending) this.finish(id, new File([transfer.bytes.buffer as ArrayBuffer], `background.${extension(transfer.mime)}`, { type: transfer.mime }));
          return;
        }
        default: throw new Error('invalidStorage');
      }
    } catch { if (id) this.finish(id, undefined, new OfficeStorageError('OFFICE_STORAGE_INVALID')); }
  }

  async read(floor: number): Promise<File | null> {
    try {
      const value = await this.request('backgroundRead', { floor });
      if (value === null || value instanceof File) return value;
      throw new Error();
    } catch { throw new Error('backgroundStorageError'); }
  }

  async write(floor: number, file: File): Promise<void> {
    if (!file.size || file.size > 4 * 1024 * 1024) throw new Error('backgroundTooLarge');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()), transferId = crypto.randomUUID(), deadline = performance.now() + 15000;
      await this.request('backgroundBegin', { floor, transferId, byteLength: bytes.length, digest: await sha256(bytes), mime: file.type });
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        if (performance.now() >= deadline) throw new Error();
        const part = bytes.subarray(offset, offset + 32768);
        await this.request('backgroundChunk', { transferId, index: offset / 32768, data: btoa(String.fromCharCode(...part)) });
      }
      await this.request('backgroundCommit', { transferId });
    } catch (error) { throw new Error(error instanceof OfficeStorageError && error.message === 'OFFICE_BACKGROUND_STORAGE_FULL' ? 'backgroundStorageFull' : 'backgroundStorageError'); }
  }

  async remove(floor: number): Promise<void> { try { await this.request('backgroundRemove', { floor }); } catch { throw new Error('backgroundStorageError'); } }
  dispose(): void {
    this.closed = true;
    for (const id of this.pending.keys()) this.finish(id, undefined, new OfficeStorageError('OFFICE_STORAGE_CLOSED'));
    if (window.petOfficeStorageResult === this.receiver) delete window.petOfficeStorageResult;
  }
}

function extension(mime: string): string { return mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'; }
async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)), value => value.toString(16).padStart(2, '0')).join('');
}

/** Coalesce transient filters, serialize writes, and rebase bounds-only conflicts once. */
export class OfficeSharedPreferencesController {
  private readonly storage: Pick<OfficeNativeStorage, 'request'>;
  private readonly changed: (state: OfficeSharedState, error: boolean, apply: boolean) => void;
  private state: OfficeSharedState;
  private desired: OfficeSharedPreferences | null = null;
  private sent: OfficeSharedPreferences | null = null;
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly seen = new Set<string>();
  constructor(initial: OfficeSharedState, storage: Pick<OfficeNativeStorage, 'request'>,
    changed: (state: OfficeSharedState, error: boolean, apply: boolean) => void) {
    this.state = parseOfficeSharedState(initial); this.storage = storage; this.changed = changed; this.seen.add(initial.revision);
  }

  adopt(raw: unknown): void {
    if (this.closed) return;
    const next = parseOfficeSharedState(raw);
    if (this.seen.has(next.revision) && next.revision !== this.state.revision) return;
    const apply = !same(next.preferences, this.state.preferences) && !same(next.preferences, this.sent);
    this.state = next; this.seen.add(next.revision);
    while (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!);
    if (apply) this.desired = null;
    this.changed(next, false, apply);
  }

  save(preferences: OfficeSharedPreferences): void {
    if (this.closed) return;
    this.desired = structuredClone(preferences);
    this.desired.appearanceOverrides = parseOfficeAppearanceOverrides(preferences.appearanceOverrides);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(false); }, 300);
  }

  async flushPending(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await this.flush(false);
  }

  private flush(rebased: boolean): Promise<void> {
    if (this.saving) return this.saving;
    if (this.closed || !this.desired || same(this.desired, this.state.preferences)) return Promise.resolve();
    const wanted = this.desired, before = this.state; this.sent = wanted;
    this.saving = this.persist(wanted, before, rebased).then(retry => {
      this.sent = null; this.saving = null;
      if (!this.closed && this.desired && !same(this.desired, this.state.preferences) && (retry || this.desired !== wanted)) return this.flush(retry);
    });
    return this.saving;
  }

  private async persist(wanted: OfficeSharedPreferences, before: OfficeSharedState, rebased: boolean): Promise<boolean> {
    let retry = false;
    try {
      const next = await this.storage.request('preferences', { expectedRevision: before.revision, preferences: wanted });
      this.adopt(next);
    } catch (error) {
      if (error instanceof OfficeStorageError && error.message === 'OFFICE_PREFERENCES_CONFLICT' && error.state !== undefined) {
        try {
          const authoritative = parseOfficeSharedState(error.state);
          retry = !rebased && same(authoritative.preferences, before.preferences);
          this.adopt(authoritative);
        } catch {
          retry = false;
        }
      }
      if (!retry && !this.closed) { this.desired = null; this.changed(this.state, true, true); }
    }
    return retry;
  }

  dispose(): void { this.closed = true; if (this.timer !== null) clearTimeout(this.timer); this.desired = null; }
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
