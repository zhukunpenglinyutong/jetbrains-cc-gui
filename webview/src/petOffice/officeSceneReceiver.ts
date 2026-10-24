import { digest, integer, keys, object, parseLiveScene, parseManifest, text } from './officeLiveModel';
import type { LiveScene, OfficeManifest } from './officeLiveModel';

const CHUNK_BYTES = 32 * 1024;
const ENVELOPE = ['schemaVersion', 'pageGeneration', 'type', 'transferId', 'sequence'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface AssetReference { requestId: string; sourceKey: string; appearanceRevision: string; manifest: OfficeManifest }
interface Staging {
  id: string; sequence: number; digest: string; byteLength: number; chunkCount: number;
  startedAt: number; chunks: Map<number, Uint8Array>; reference?: AssetReference;
}
interface ReceiverOptions {
  page: string;
  send: (command: 'sceneAck' | 'resync', fields?: Record<string, unknown>) => void;
  scene: (scene: LiveScene, receivedAt: number) => void;
  assetAllowed: (reference: AssetReference) => boolean;
  asset: (reference: AssetReference, bytes: Uint8Array) => void;
  result: (requestId: string, result: string) => void;
  error: (code: string) => void;
  now?: () => number;
  hash?: (bytes: Uint8Array) => Promise<string>;
}
export async function officeDigest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Bound nesting before JSON.parse; strings may contain escaped braces and quotes. */
function boundedJson(bytes: Uint8Array): unknown {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let depth = 0, tokens = 0, quoted = false, escaped = false;
  for (const char of value) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 32 || ++tokens > 100_000) throw new Error('invalidScene'); }
    else if (char === '}' || char === ']') depth--;
    else if (char === ',' && ++tokens > 100_000) throw new Error('invalidScene');
  }
  return JSON.parse(value) as unknown;
}

/** Complete snapshots only. Older page, sequence, connection and async hash completions have no authority. */
export class OfficeSceneReceiver {
  private readonly options: ReceiverOptions;
  private readonly now: () => number;
  private readonly hash: (bytes: Uint8Array) => Promise<string>;
  private stagedScene: Staging | null = null;
  private assets = new Map<string, Staging>();
  private highestSequence = 0;
  private complete: LiveScene | null = null;
  private receivedAt = 0;
  private lastResync = -Infinity;
  private closed = false;

  constructor(options: ReceiverOptions) {
    this.options = options; this.now = options.now ?? (() => performance.now()); this.hash = options.hash ?? officeDigest;
  }

  receive(value: unknown): void {
    if (this.closed) return;
    try {
      const packet = object(value);
      if (packet.pageGeneration !== this.options.page) return;
      if (packet.schemaVersion !== 1 || JSON.stringify(packet).length > 64 * 1024) throw new Error('invalidScene');
      const type = text(packet.type, 32);
      if (type === 'REQUEST_RESULT') {
        keys(packet, ['schemaVersion', 'pageGeneration', 'type', 'requestId', 'result']);
        const requestId = text(packet.requestId, 36), result = text(packet.result, 32);
        if (!UUID.test(requestId) || !['ACTIVATED', 'ATTENTION_REQUESTED', 'TARGET_GONE', 'STALE_INTERACTION', 'UNAVAILABLE', 'ASSET_RETRY', 'ASSET_BUSY'].includes(result)) throw new Error('invalidScene');
        this.options.result(requestId, result); return;
      }
      const asset = type.startsWith('ASSET_');
      if (!['SCENE_BEGIN', 'SCENE_CHUNK', 'SCENE_COMMIT', 'ASSET_BEGIN', 'ASSET_CHUNK', 'ASSET_COMMIT'].includes(type)) throw new Error('invalidScene');
      const id = text(packet.transferId, 36), sequence = integer(packet.sequence);
      if (!UUID.test(id) || (asset ? sequence !== 0 : sequence < 1)) throw new Error('invalidScene');
      if (type.endsWith('_BEGIN')) { this.begin(packet, asset, id, sequence); return; }
      const stage = asset ? this.assets.get(id) : this.stagedScene;
      if (!stage || stage.id !== id || stage.sequence !== sequence) return;
      if (this.now() - stage.startedAt >= (asset ? 15_000 : 10_000)) throw new Error('transferTimeout');
      if (type.endsWith('_CHUNK')) {
        keys(packet, [...ENVELOPE, 'index', 'data']);
        const index = integer(packet.index, stage.chunkCount - 1), data = text(packet.data, 44_000);
        if (stage.chunks.has(index) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalidScene');
        const binary = atob(data), expected = Math.min(CHUNK_BYTES, stage.byteLength - index * CHUNK_BYTES);
        if (binary.length !== expected) throw new Error('invalidScene');
        stage.chunks.set(index, Uint8Array.from(binary, char => char.charCodeAt(0)));
      } else {
        keys(packet, ENVELOPE);
        if (stage.chunks.size !== stage.chunkCount) throw new Error('invalidScene');
        void this.commit(stage, asset);
      }
    } catch {
      this.stagedScene = null; this.assets.clear(); this.options.error('invalidScene'); this.resync();
    }
  }

  private begin(packet: Record<string, unknown>, asset: boolean, id: string, sequence: number): void {
    keys(packet, [...ENVELOPE, 'byteLength', 'chunkCount', 'digest', ...(asset ? ['requestId', 'sourceKey', 'appearanceRevision', 'manifest'] : [])]);
    const byteLength = integer(packet.byteLength, (asset ? 4 : 2) * 1024 * 1024), chunkCount = integer(packet.chunkCount, asset ? 128 : 64);
    if (!byteLength || chunkCount !== Math.ceil(byteLength / CHUNK_BYTES)) throw new Error('invalidScene');
    const stage: Staging = { id, sequence, byteLength, chunkCount, digest: digest(packet.digest), startedAt: this.now(), chunks: new Map() };
    if (asset) {
      stage.reference = { requestId: text(packet.requestId, 36), sourceKey: text(packet.sourceKey, 386), appearanceRevision: digest(packet.appearanceRevision), manifest: parseManifest(packet.manifest) };
      if (!UUID.test(stage.reference.requestId) || stage.reference.manifest.digest !== stage.digest || stage.reference.manifest.byteLength !== byteLength || !this.options.assetAllowed(stage.reference)) return;
      if (this.assets.size >= 2 || this.assets.has(id) || [...this.assets.values()].some(value => value.reference?.requestId === stage.reference?.requestId)) throw new Error('invalidScene');
      this.assets.set(id, stage);
    } else {
      if (sequence <= this.highestSequence) return;
      this.highestSequence = sequence; this.stagedScene = stage;
    }
  }

  private async commit(stage: Staging, asset: boolean): Promise<void> {
    // Duplicate commits cannot start extra digest/decode work.
    const bytes = new Uint8Array(stage.byteLength);
    for (const [index, chunk] of stage.chunks) bytes.set(chunk, index * CHUNK_BYTES);
    stage.chunks.clear();
    try {
      if (await this.hash(bytes) !== stage.digest) throw new Error('invalidScene');
      if (this.closed || this.now() - stage.startedAt >= (asset ? 15_000 : 10_000)) return;
      if (asset) {
        if (this.assets.get(stage.id) !== stage || !stage.reference || !this.options.assetAllowed(stage.reference)) return;
        this.assets.delete(stage.id); this.options.asset(stage.reference, bytes);
      } else {
        if (this.stagedScene !== stage) return;
        const scene = parseLiveScene(boundedJson(bytes));
        if (this.complete) {
          if (scene.instanceId !== this.complete.instanceId || scene.connectionEpoch !== this.complete.connectionEpoch || scene.watermark < this.complete.watermark) throw new Error('invalidScene');
          const previous = new Map(this.complete.sources.map(source => [source.sourceKey, source]));
          if (scene.sources.some(source => source.sourceRevision < (previous.get(source.sourceKey)?.sourceRevision ?? 0)
            || source.observationRevision < (previous.get(source.sourceKey)?.observationRevision ?? 0))) throw new Error('invalidScene');
        }
        const elapsed = Math.max(0, this.now() - stage.startedAt);
        for (const source of scene.sources) {
          source.observationAgeMillis += elapsed;
          source.terminalGraceRemainingMillis = Math.max(0, source.terminalGraceRemainingMillis - elapsed);
        }
        this.complete = scene; this.receivedAt = this.now(); this.stagedScene = null;
        this.options.scene(scene, this.receivedAt);
        this.options.send('sceneAck', { transferId: stage.id, sequence: stage.sequence });
      }
    } catch {
      if (!this.closed && (asset ? this.assets.get(stage.id) === stage : this.stagedScene === stage)) {
        if (asset) { this.assets.delete(stage.id); if (stage.reference) this.options.result(stage.reference.requestId, 'ASSET_RETRY'); }
        else { this.stagedScene = null; this.options.error('invalidScene'); this.resync(); }
      }
    }
  }

  poll(): void {
    if (this.closed) return;
    const now = this.now();
    if (this.stagedScene && now - this.stagedScene.startedAt >= 10_000) { this.stagedScene = null; this.options.error('transferTimeout'); this.resync(); }
    for (const [id, stage] of this.assets) {
      if (now - stage.startedAt >= 15_000 || stage.reference && !this.options.assetAllowed(stage.reference)) this.assets.delete(id);
    }
    if (!this.complete || now - this.receivedAt >= 10_000) this.resync();
  }
  isStale(): boolean { return !this.complete || this.now() - this.receivedAt >= 15_000; }
  resync(): void {
    if (!this.closed && this.now() - this.lastResync >= 2000) { this.lastResync = this.now(); this.options.send('resync'); }
  }
  dispose(): void { this.closed = true; this.stagedScene = null; this.assets.clear(); this.complete = null; }
}
