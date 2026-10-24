import { inspectOfficeImage, loadOfficeImage, OFFICE_DECODE_MAX_BYTES, planOfficeImageDecode } from './officeAssets';
import type { OfficeAsset } from './officeAssets';
import type { LiveSource, OfficeManifest, PetAction, PetState } from './officeLiveModel';
import type { AssetReference } from './officeSceneReceiver';
import type { OfficePetVisual } from './officeRenderer';
import { officeBackgroundAllowance, resolveOfficeCacheBudget } from './officeCachePreferences';

interface PendingAsset { reference: AssetReference; startedAt: number; decoding: boolean; controller: AbortController }
interface PoolOptions {
  request: (reference: AssetReference) => void;
  changed: () => void;
  now?: () => number;
  decode?: typeof loadOfficeImage;
  externalDecodedBytes?: () => number;
  decodedBudgetBytes?: () => number;
}
const ACTION_ROWS: Record<PetAction, readonly [number, number]> = {
  idle: [0, 6], 'running-right': [1, 8], 'running-left': [2, 8], waving: [3, 4], jumping: [4, 5],
  failed: [5, 8], waiting: [6, 6], running: [7, 6], review: [8, 6],
};
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function seed(value: string): number { let result = 0; for (const char of value) result = (result * 31 + char.charCodeAt(0)) >>> 0; return result; }
export function sourceAction(source: LiveSource, celebrate = true): PetAction {
  if (source.phase === 'WAITING_USER') return 'waiting';
  let state: PetState = 'idle';
  if (source.phase === 'RUNNING') state = 'running';
  else if (source.phase === 'THINKING') state = 'thinking';
  else if (celebrate && source.phase === 'SUCCEEDED') state = 'success';
  else if (celebrate && source.phase === 'FAILED') state = 'error';
  const choices = source.appearance.actionMappings[state];
  return choices[seed(`${source.sourceKey}/${source.turnId}/${source.appearance.revision}/${state}`) % choices.length];
}
function sameManifest(a: OfficeManifest, b: OfficeManifest): boolean {
  return a.digest === b.digest && a.kind === b.kind && a.mime === b.mime && a.width === b.width && a.height === b.height && a.byteLength === b.byteLength;
}

/** Shared decoded bytes, independent actor mappings/cursors. Two transfers, one native decode and a configurable aggregate budget. */
export class OfficeLiveAssetPool {
  private readonly options: PoolOptions;
  private readonly now: () => number;
  private readonly decode: typeof loadOfficeImage;
  private sources = new Map<string, LiveSource>();
  private desired = new Map<string, LiveSource>();
  private retainedDigests = new Set<string>();
  private cache = new Map<string, OfficeAsset>();
  private pending = new Map<string, PendingAsset>();
  private failures = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private reserved = 0;
  private previousLimit = 0;

  constructor(options: PoolOptions) { this.options = options; this.now = options.now ?? (() => performance.now()); this.decode = options.decode ?? loadOfficeImage; }
  syncSources(sources: readonly LiveSource[]): void {
    this.sources = new Map(sources.map(source => [source.sourceKey, source]));
    const revisions = new Set(sources.map(source => source.appearance.revision));
    for (const revision of this.failures.keys()) if (!revisions.has(revision)) this.failures.delete(revision);
    for (const [id, pending] of this.pending) {
      if (!this.allowed(pending.reference)) { pending.controller.abort(); if (!pending.decoding) this.pending.delete(id); }
    }
  }
  demand(sources: readonly LiveSource[], retained: readonly LiveSource[] = []): void {
    this.retainedDigests = new Set(retained.slice(0, 12).map(source => source.appearance.manifest.digest).filter(Boolean));
    this.desired = new Map(sources.slice(0, 26).map(source => [source.sourceKey, source]));
    const digests = new Set([...this.desired.values()].map(source => source.appearance.manifest.digest));
    for (const [id, pending] of this.pending) {
      if (!digests.has(pending.reference.manifest.digest)) { pending.controller.abort(); if (!pending.decoding) this.pending.delete(id); }
    }
    this.pump();
  }
  private pump(): void {
    if (this.closed) return;
    const digests = new Set([...this.desired.values()].map(source => source.appearance.manifest.digest).filter(Boolean));
    const limit = this.imageLimit();
    let released = false;
    for (const [digest, asset] of this.cache) if (!digests.has(digest) && !this.retainedDigests.has(digest) || asset.decodedBytes > limit) { asset.release(); this.cache.delete(digest); released = true; }
    if (released || limit !== this.previousLimit) for (const [revision, reason] of this.failures) if (reason === 'decodeBudget') this.failures.delete(revision);
    this.previousLimit = limit;
    if (released) this.options.changed();
    for (const source of this.desired.values()) {
      const appearance = source.appearance, manifest = appearance.manifest;
      if (this.pending.size >= 2) break;
      if (!manifest.digest || this.cache.has(manifest.digest) || this.failures.has(appearance.revision)
        || [...this.pending.values()].some(pending => pending.reference.manifest.digest === manifest.digest)) continue;
      const reference = { requestId: crypto.randomUUID(), sourceKey: source.sourceKey, appearanceRevision: appearance.revision, manifest };
      this.pending.set(reference.requestId, { reference, startedAt: this.now(), decoding: false, controller: new AbortController() });
      this.options.request(reference);
    }
  }
  private imageLimit(): number {
    const unique = new Set([...this.desired.values()].map(source => source.appearance.manifest.digest).filter(Boolean)).size;
    // Leave room for the current floor background; a shared digest consumes one image allowance.
    const budget = resolveOfficeCacheBudget(this.options.decodedBudgetBytes?.());
    const available = Math.max(0, Math.min(budget - officeBackgroundAllowance(budget), budget - (this.options.externalDecodedBytes?.() ?? 0)));
    return Math.min(OFFICE_DECODE_MAX_BYTES, Math.floor(available / Math.max(1, unique)));
  }
  reconfigureBudget(): void {
    if (this.closed) return;
    for (const [id, pending] of this.pending) { pending.controller.abort(); if (!pending.decoding) this.pending.delete(id); }
    for (const asset of this.cache.values()) asset.release(); this.cache.clear(); this.failures.clear();
    this.pump(); this.options.changed();
  }
  allowed(reference: AssetReference): boolean {
    const source = this.sources.get(reference.sourceKey), pending = this.pending.get(reference.requestId);
    return !this.closed && !!source && !!pending && !pending.controller.signal.aborted
      && pending.reference.appearanceRevision === reference.appearanceRevision && source.appearance.revision === reference.appearanceRevision
      && sameManifest(source.appearance.manifest, reference.manifest) && sameManifest(pending.reference.manifest, reference.manifest);
  }
  accept(reference: AssetReference, bytes: Uint8Array): void {
    const pending = this.pending.get(reference.requestId);
    if (!pending || pending.decoding || !this.allowed(reference)) return;
    pending.decoding = true;
    this.chain = this.chain.then(async () => {
      try {
        if (!this.allowed(reference)) return;
        const manifest = reference.manifest, name = `pet.${EXTENSIONS[manifest.mime]}`;
        const header = inspectOfficeImage(bytes, name);
        if (bytes.length !== manifest.byteLength || header.mime !== manifest.mime || header.width !== manifest.width || header.height !== manifest.height) throw new Error('invalidImage');
        const options = { maxDecodedBytes: this.imageLimit() }, plan = planOfficeImageDecode(header, options), cost = plan.decodedBytes;
        if (this.decodedBytes() + cost + (this.options.externalDecodedBytes?.() ?? 0) > resolveOfficeCacheBudget(this.options.decodedBudgetBytes?.())) throw new Error('decodeBudget');
        this.reserved = cost;
        const asset = await this.decode(new File([bytes.slice().buffer], name, { type: manifest.mime }), pending.controller.signal, options);
        if (!this.allowed(reference)) { asset.release(); return; }
        if ((asset.kind === 'sheet') !== (manifest.kind === 'sheet') || asset.decodedBytes > cost) { asset.release(); throw new Error('invalidImage'); }
        if (asset.decodedBytes > this.imageLimit()) { asset.release(); return; }
        const previous = this.cache.get(manifest.digest); previous?.release(); this.cache.set(manifest.digest, asset);
      } catch (failure) {
        if (this.allowed(reference)) this.failures.set(reference.appearanceRevision, failure instanceof Error ? failure.message : 'imageError');
      } finally {
        this.reserved = 0; this.pending.delete(reference.requestId);
        if (!this.closed) { this.options.changed(); this.pump(); }
      }
    });
  }
  result(id: string, result: string): void {
    const pending = this.pending.get(id);
    if (!pending || pending.decoding) return;
    this.pending.delete(id);
    if (this.allowedSource(pending.reference)) this.failures.set(pending.reference.appearanceRevision, result);
    pending.controller.abort(); this.options.changed(); this.pump();
  }
  private allowedSource(reference: AssetReference): boolean {
    return !this.closed && this.sources.get(reference.sourceKey)?.appearance.revision === reference.appearanceRevision;
  }
  poll(): void {
    for (const [id, pending] of this.pending) {
      if (!pending.decoding && this.now() - pending.startedAt >= 15_000) this.result(id, 'transferTimeout');
    }
  }
  retry(): void { this.failures.clear(); this.pump(); this.options.changed(); }
  status(source: LiveSource): string {
    if (this.cache.has(source.appearance.manifest.digest)) return 'READY';
    return this.failures.get(source.appearance.revision) ?? (source.appearance.manifest.digest && !this.cache.has(source.appearance.manifest.digest) ? 'assetLoading' : source.appearance.status);
  }
  decodedBytes(): number { return [...this.cache.values()].reduce((sum, asset) => sum + asset.decodedBytes, 0) + this.reserved; }
  inFlight(): number { return this.pending.size; }
  diagnostics(): { images: number; optimized: number; loading: number; fallback: number } {
    const desired = [...this.desired.values()];
    const optimized = [...this.cache].filter(([digest, asset]) => {
      const source = desired.find(value => value.appearance.manifest.digest === digest);
      return !!source && (asset.width < source.appearance.manifest.width || asset.height < source.appearance.manifest.height);
    }).length;
    return { images: this.cache.size, optimized, loading: desired.filter(source => this.status(source) === 'assetLoading').length,
      fallback: desired.filter(source => !['READY', 'BUILTIN', 'assetLoading'].includes(this.status(source))).length };
  }
  visual(source: LiveSource, celebrate = true): OfficePetVisual {
    const asset = this.cache.get(source.appearance.manifest.digest);
    const phase = !celebrate && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(source.phase) ? 'IDLE' : source.phase;
    const base = { opacity: source.appearance.opacity, builtinPhase: phase };
    if (!asset) return { ...base, frame: () => null };
    const cursor = seed(`${source.sourceKey}/${source.turnId}/${source.appearance.revision}`), action = sourceAction(source, celebrate);
    const [row, frames] = ACTION_ROWS[action], totalDuration = asset.durations.reduce((sum, value) => sum + value, 0);
    return { ...base, width: asset.width, height: asset.height,
      frame: (_actor, time) => {
        if (asset.kind !== 'animated') return asset.frames[0];
        let elapsed = (time + cursor % 10_000) % totalDuration;
        for (let index = 0; index < asset.frames.length; index++) { if (elapsed < asset.durations[index]) return asset.frames[index]; elapsed -= asset.durations[index]; }
        return asset.frames[0];
      },
      crop: asset.kind === 'sheet' ? (_actor, time) => ({ x: Math.floor(time / 140 + cursor % 1000) % frames * (asset.cellWidth ?? 192), y: row * (asset.cellHeight ?? 208), width: asset.cellWidth ?? 192, height: asset.cellHeight ?? 208 }) : undefined,
    };
  }
  dispose(): void {
    this.closed = true; for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear(); for (const asset of this.cache.values()) asset.release(); this.cache.clear(); this.sources.clear(); this.desired.clear(); this.retainedDigests.clear(); this.failures.clear();
  }
}
