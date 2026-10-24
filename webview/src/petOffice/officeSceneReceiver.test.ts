import { describe, expect, it, vi } from 'vitest';
import { OfficeSceneReceiver } from './officeSceneReceiver';
import { liveSceneFixture } from './officeLiveFixtures';
import type { LiveScene } from './officeLiveModel';

const page = '11111111-1111-4111-8111-111111111111', transferId = '22222222-2222-4222-8222-222222222222', digest = 'a'.repeat(64);
function frames(value: unknown, sequence = 1, id = transferId) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const count = Math.ceil(bytes.length / 32768), envelope = { schemaVersion: 1, pageGeneration: page, transferId: id, sequence };
  const chunks = Array.from({ length: count }, (_, index) => ({ ...envelope, type: 'SCENE_CHUNK', index, data: btoa(String.fromCharCode(...bytes.slice(index * 32768, (index + 1) * 32768))) }));
  return [{ ...envelope, type: 'SCENE_BEGIN', byteLength: bytes.length, chunkCount: count, digest }, ...chunks, { ...envelope, type: 'SCENE_COMMIT' }];
}
function harness(hash: (bytes: Uint8Array) => Promise<string> = async () => digest) {
  let now = 0; const scenes: LiveScene[] = [], send = vi.fn(), error = vi.fn();
  const receiver = new OfficeSceneReceiver({ page, send, scene: scene => scenes.push(scene), assetAllowed: () => false, asset: vi.fn(), result: vi.fn(), error, hash, now: () => now });
  return { receiver, scenes, send, error, advance: (millis: number) => { now += millis; } };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
describe('complete scene receiver', () => {
  it('applies no partial roster and acknowledges only the digested complete scene', async () => {
    const h = harness(), packets = frames(liveSceneFixture());
    packets.slice(0, -1).forEach(packet => h.receiver.receive(packet)); expect(h.scenes).toHaveLength(0);
    h.receiver.receive(packets.at(-1)); await settle(); expect(h.scenes).toHaveLength(1); expect(h.send).toHaveBeenCalledWith('sceneAck', { transferId, sequence: 1 });
  });
  it('preserves the last complete roster after missing chunks and throttles recovery', async () => {
    const h = harness(); frames(liveSceneFixture()).forEach(packet => h.receiver.receive(packet)); await settle();
    const broken = frames(liveSceneFixture(['IDLE']), 2); h.receiver.receive(broken[0]); h.receiver.receive(broken.at(-1)); h.receiver.poll();
    expect(h.scenes).toHaveLength(1); expect(h.send.mock.calls.filter(call => call[0] === 'resync')).toHaveLength(1);
  });
  it('rejects old pages, duplicate sequences, changed connections and decreasing watermarks', async () => {
    const h = harness(); frames(liveSceneFixture()).forEach(packet => h.receiver.receive(packet)); await settle();
    frames(liveSceneFixture(['IDLE'])).forEach(packet => h.receiver.receive(packet));
    frames(liveSceneFixture(['IDLE']), 2).forEach(packet => h.receiver.receive({ ...packet, pageGeneration: 'old-page' }));
    const changed = liveSceneFixture(); changed.snapshot.connectionEpoch = 'old-connection'; frames(changed, 3).forEach(packet => h.receiver.receive(packet)); await settle();
    const older = liveSceneFixture(); older.snapshot.watermark = 0; frames(older, 4).forEach(packet => h.receiver.receive(packet)); await settle();
    expect(h.scenes).toHaveLength(1);
  });
  it('a late hash completion cannot overwrite a newer staged scene', async () => {
    const hashes: Array<(hash: string) => void> = []; const h = harness(() => new Promise(resolve => hashes.push(resolve)));
    frames(liveSceneFixture()).forEach(packet => h.receiver.receive(packet)); frames(liveSceneFixture(['THINKING']), 2).forEach(packet => h.receiver.receive(packet));
    hashes[1](digest); await settle(); hashes[0](digest); await settle(); expect(h.scenes).toHaveLength(1); expect(h.scenes[0].sources[0].phase).toBe('THINKING');
  });
  it('rejects corrupted bytes and a deep or mismatched snapshot without applying it', async () => {
    const h = harness(async () => 'b'.repeat(64)); frames(liveSceneFixture()).forEach(packet => h.receiver.receive(packet)); await settle(); expect(h.scenes).toHaveLength(0);
    const invalid = harness(); let deep: unknown = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
    frames(deep).forEach(packet => invalid.receiver.receive(packet)); await settle(); expect(invalid.scenes).toHaveLength(0); expect(invalid.error).toHaveBeenCalled();
  });
  it('expires staging, adjusts age/grace for transfer time and closes late callbacks', async () => {
    const h = harness(), packets = frames(liveSceneFixture(['SUCCEEDED'])); h.receiver.receive(packets[0]); h.advance(4000); packets.slice(1).forEach(packet => h.receiver.receive(packet)); await settle();
    expect(h.scenes[0].sources[0].terminalGraceRemainingMillis).toBe(1000); expect(h.scenes[0].sources[0].observationAgeMillis).toBe(4000);
    h.receiver.receive(frames(liveSceneFixture(), 2)[0]); h.advance(10_000); h.receiver.poll(); expect(h.error).toHaveBeenCalledWith('transferTimeout');
    h.receiver.dispose(); frames(liveSceneFixture(), 3).forEach(packet => h.receiver.receive(packet)); await settle(); expect(h.scenes).toHaveLength(1);
  });
  it('rejects declared capacity and duplicate chunks before assembling pixels or JSON', () => {
    const h = harness(), packets = frames(liveSceneFixture()); h.receiver.receive({ ...packets[0], byteLength: 3 * 1024 * 1024 });
    expect(h.error).toHaveBeenCalled(); h.receiver.receive(frames(liveSceneFixture(), 2)[0]);
    const chunk = frames(liveSceneFixture(), 2)[1]; h.receiver.receive(chunk); h.receiver.receive(chunk); expect(h.scenes).toHaveLength(0);
  });
});
