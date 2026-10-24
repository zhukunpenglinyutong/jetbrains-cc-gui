import type { LiveScene, LiveSource } from './officeLiveModel';

export const OFFICE_ATTENTION_DELAY = 30_000;
export const OFFICE_EFFECT_DURATION = 3_000;
export const OFFICE_MAX_EFFECTS = 12;
export interface OfficeTaskEffect { sourceKey: string; identity: string; outcome: string; startedAt: number; expiresAt: number }
interface Waiting { identity: string; since: number; notified: boolean }

/** Bounded, Office-local feedback. Recovery seeds state; only uninterrupted live transitions celebrate. */
export class OfficeFeedback {
  private previous: LiveScene | null = null;
  private receivedAt = -Infinity;
  private readonly seen = new Set<string>();
  private readonly waits = new Map<string, Waiting>();
  private readonly effects = new Map<string, OfficeTaskEffect>();
  private nextAttentionAt = 0;

  accept(scene: LiveScene, now: number, animate: boolean, visible?: ReadonlySet<string>): void {
    const continuous = this.previous?.instanceId === scene.instanceId && this.previous.connectionEpoch === scene.connectionEpoch
      && now >= this.receivedAt && now - this.receivedAt < 15_000;
    const before = new Map(this.previous?.sources.map(source => [source.sourceKey, source]) ?? []);
    if (!continuous) { this.waits.clear(); this.effects.clear(); }
    const active = new Set(scene.sources.map(source => source.sourceKey));
    for (const key of this.waits.keys()) if (!active.has(key)) this.waits.delete(key);
    for (const key of this.effects.keys()) if (!active.has(key)) this.effects.delete(key);
    for (const source of scene.sources) {
      const old = before.get(source.sourceKey);
      const existing = this.effects.get(source.sourceKey);
      if (existing && (existing.identity !== source.terminalEventId && existing.identity !== waitIdentity(source))) this.effects.delete(source.sourceKey);
      if (source.phase === 'WAITING_USER' && source.pendingInteractionId && source.turnId && source.observationAgeMillis < 15_000) {
        const identity = waitIdentity(source);
        if (this.waits.get(source.sourceKey)?.identity !== identity) this.waits.set(source.sourceKey, { identity, since: now, notified: false });
      } else this.waits.delete(source.sourceKey);
      if (source.terminalEventId) {
        if (continuous && animate && (!visible || visible.has(source.sourceKey)) && old?.turnId === source.turnId && old.outcome === 'NONE'
          && old.observationAgeMillis < 15_000 && source.observationAgeMillis < 15_000 && !this.seen.has(source.terminalEventId)
          && source.terminalGraceRemainingMillis > 0) {
          this.add({ sourceKey: source.sourceKey, identity: source.terminalEventId, outcome: source.outcome, startedAt: now,
            expiresAt: now + Math.min(OFFICE_EFFECT_DURATION, source.terminalGraceRemainingMillis) });
        }
        this.seen.add(source.terminalEventId);
      }
    }
    while (this.seen.size > 50) this.seen.delete(this.seen.values().next().value!);
    this.previous = scene; this.receivedAt = now;
    this.active(now);
  }

  attention(now: number, enabled: boolean, animate: boolean, visible?: ReadonlySet<string>): Set<string> {
    const keys = new Set<string>();
    if (!enabled || now - this.receivedAt >= 15_000) return keys;
    for (const [key, wait] of this.waits) if (now - wait.since >= OFFICE_ATTENTION_DELAY) {
      keys.add(key);
      if (!wait.notified && animate && (!visible || visible.has(key)) && now >= this.nextAttentionAt) {
        wait.notified = true; this.nextAttentionAt = now + 5_000;
        this.add({ sourceKey: key, identity: wait.identity, outcome: 'WAITING_USER', startedAt: now, expiresAt: now + OFFICE_EFFECT_DURATION });
      }
    }
    return keys;
  }

  active(now: number): OfficeTaskEffect[] {
    for (const [key, effect] of this.effects) if (now >= effect.expiresAt || now - this.receivedAt >= 15_000) this.effects.delete(key);
    return [...this.effects.values()];
  }

  clearEffects(): void { this.effects.clear(); }

  private add(effect: OfficeTaskEffect): void {
    this.effects.delete(effect.sourceKey); this.effects.set(effect.sourceKey, effect);
    while (this.effects.size > OFFICE_MAX_EFFECTS) this.effects.delete(this.effects.keys().next().value!);
  }
}

function waitIdentity(source: LiveSource): string { return `${source.sourceKey}/${source.turnId}/${source.pendingInteractionId}`; }
