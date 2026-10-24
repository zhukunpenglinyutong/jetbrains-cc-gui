import { describe, expect, it } from 'vitest';
import { liveSceneFixture } from './officeLiveFixtures';
import { OfficeSeatAllocator, parseLiveScene, presentSource } from './officeLiveModel';
import { sourceAction } from './officeLiveAssets';

describe('live office model', () => {
  it('accepts only a complete typed local roster, including idle and waiting ownership', () => {
    const scene = parseLiveScene(liveSceneFixture());
    expect(scene.sources.map(source => source.phase)).toEqual(['RUNNING', 'WAITING_USER', 'IDLE']);
    expect(scene.sources[1].pendingInteractionId).toBe('interaction-1');
  });
  it('rejects missing appearances, duplicate identities, unknown command fields and invalid labels', () => {
    const missing = liveSceneFixture(); delete missing.appearances['instance-A/tab-0/binding-0']; expect(() => parseLiveScene(missing)).toThrow();
    const duplicate = liveSceneFixture(); duplicate.snapshot.sources.push(duplicate.snapshot.sources[0]); expect(() => parseLiveScene(duplicate)).toThrow();
    expect(() => parseLiveScene({ ...liveSceneFixture(), sendPrompt: 'unexpected' })).toThrow();
    const invalid = liveSceneFixture(); invalid.snapshot.sources[0].metadata.tabLabel = '\u0000'; expect(() => parseLiveScene(invalid)).toThrow();
  });
  it('rejects source capacity, foreign instances and contradictory question ownership', () => {
    const large = liveSceneFixture(Array.from({ length: 257 }, () => 'RUNNING')); expect(() => parseLiveScene(large)).toThrow();
    const foreign = liveSceneFixture(); foreign.snapshot.sources[0].sourceKey.instanceId = 'other'; expect(() => parseLiveScene(foreign)).toThrow();
    const pathSegment = liveSceneFixture(); pathSegment.snapshot.sources[0].sourceKey.instanceId = '..'; pathSegment.snapshot.instanceId = '..'; expect(() => parseLiveScene(pathSegment)).toThrow();
    const waiting = liveSceneFixture(); waiting.snapshot.sources[1].execution.pendingInteractionId = ''; expect(() => parseLiveScene(waiting)).toThrow();
  });
  it('admits foreign sources only through the complete explicit participant roster', () => {
    const wire = liveSceneFixture(['RUNNING', 'WAITING_USER']);
    const source = wire.snapshot.sources[1];
    const oldKey = Object.values(source.sourceKey).join('/');
    source.sourceKey.instanceId = 'instance-B';
    source.metadata.productName = 'PyCharm';
    const newKey = Object.values(source.sourceKey).join('/');
    wire.appearances[newKey] = { ...wire.appearances[oldKey], status: 'REMOTE_PENDING' };
    delete wire.appearances[oldKey];
    expect(() => parseLiveScene(wire)).toThrow();
    const scene = parseLiveScene({ ...wire, participants: ['instance-A', 'instance-B'] });
    expect(scene.sources[1].sourceKey).toBe(newKey);
    expect(scene.sources[1].product).toBe('PyCharm');
    expect(scene.sources[1].appearance.status).toBe('REMOTE_PENDING');
    expect(scene.sources[1].pendingInteractionId).toBe('interaction-1');
  });
  it('rejects omitted owners, duplicate participants, unlisted identities and participant overflow', () => {
    for (const participants of [[], ['other'], ['instance-A', 'instance-A'], ['instance-A', ...Array.from({ length: 16 }, (_, i) => `peer-${i}`)]]) {
      expect(() => parseLiveScene({ ...liveSceneFixture(), participants })).toThrow();
    }
    const wire = liveSceneFixture(); wire.snapshot.sources[0].sourceKey.instanceId = 'unlisted';
    expect(() => parseLiveScene({ ...wire, participants: ['instance-A', 'instance-B'] })).toThrow();
  });
  it('expires observed work and question actions without fabricating an outcome', () => {
    const source = parseLiveScene(liveSceneFixture()).sources[1];
    const stale = presentSource(source, 15_000); expect(stale.phase).toBe('UNKNOWN'); expect(stale.pendingInteractionId).toBe(''); expect(stale.outcome).toBe('NONE');
    expect(presentSource(source, 1, true).phase).toBe('UNKNOWN');
  });
  it('retires terminal actors after the remaining monotonic grace', () => {
    const source = parseLiveScene(liveSceneFixture(['SUCCEEDED'])).sources[0];
    expect(presentSource(source, 4999).phase).toBe('SUCCEEDED'); expect(presentSource(source, 5000).phase).toBe('IDLE');
  });
  it('preserves explicit disconnected uncertainty and never revives a terminal actor from it', () => {
    const source = parseLiveScene(liveSceneFixture(['SUCCEEDED'])).sources[0];
    expect(presentSource({ ...source, phase: 'UNKNOWN' }, 20_000).phase).toBe('UNKNOWN');
    expect(presentSource(source, 20_000).phase).toBe('IDLE');
    const idle = parseLiveScene(liveSceneFixture(['IDLE'])).sources[0];
    expect(presentSource(idle, 20_000).phase).toBe('IDLE');
    expect(presentSource(idle, 1, true).phase).toBe('UNKNOWN');
  });
  it('keeps active desks stable when optional idle desks disappear', () => {
    const scene = parseLiveScene(liveSceneFixture(['IDLE', 'RUNNING', 'WAITING_USER'])); const seats = new OfficeSeatAllocator();
    const all = seats.assign(scene.sources, true), active = seats.assign(scene.sources, false);
    expect(active).toHaveLength(2); expect(active[0].seat).toBe(all[1].seat); expect(active[1].seat).toBe(all[2].seat);
    expect(all[0].seat).toBeGreaterThan(all[1].seat);
  });
  it('preserves each actor mapping for the same bitmap and suppresses recovered celebrations', () => {
    const sources = parseLiveScene(liveSceneFixture(['RUNNING', 'RUNNING', 'SUCCEEDED'])).sources;
    sources[0].appearance.actionMappings.running = ['running-left']; sources[1].appearance.actionMappings.running = ['running-right'];
    expect(sourceAction(sources[0])).toBe('running-left'); expect(sourceAction(sources[1])).toBe('running-right');
    expect(sourceAction(sources[2], false)).toBe('idle'); expect(sourceAction(sources[2], true)).toBe('jumping');
  });
});
