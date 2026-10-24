import type { LiveSource } from './officeLiveModel';

export interface OfficeActorMotion { alpha: number; lift: number; exiting: boolean }
interface Actor { source: LiveSource; since: number }
const DURATION = 220;
const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Bounded presentation tails have no authority over source lifetime or navigation. */
export class OfficeTransitions {
  private context = '';
  private active = new Map<string, Actor>();
  private leaving = new Map<string, Actor>();
  private sceneSince = -Infinity;

  sync(sources: readonly LiveSource[], context: string, now: number, animate: boolean): void {
    const changed = context !== this.context;
    if (changed || !animate) {
      this.sceneSince = changed && this.context && animate && sources.length ? now : -Infinity;
      this.context = context; this.active.clear(); this.leaving.clear();
      for (const source of sources) this.active.set(source.sourceKey, { source, since: -Infinity });
      return;
    }
    const keys = new Set(sources.map(source => source.sourceKey));
    const seats = new Set(sources.map(source => source.seat));
    for (const [key, actor] of this.active) {
      if (!keys.has(key)) { this.active.delete(key); if (!seats.has(actor.source.seat)) this.leaving.set(key, { source: actor.source, since: now }); }
    }
    for (const source of sources) {
      const previous = this.active.get(source.sourceKey);
      this.active.set(source.sourceKey, { source, since: previous?.since ?? now });
      this.leaving.delete(source.sourceKey);
    }
    for (const [key, actor] of this.leaving) if (seats.has(actor.source.seat) || now - actor.since >= DURATION) this.leaving.delete(key);
    while (this.leaving.size > 12) this.leaving.delete(this.leaving.keys().next().value!);
  }

  frame(now: number): { source: LiveSource; motion: OfficeActorMotion }[] {
    const result = [...this.active.values()].map(actor => {
      const t = ease((now - actor.since) / DURATION);
      return { source: actor.source, motion: { alpha: t, lift: (1 - t) * 7, exiting: false } };
    });
    for (const [key, actor] of this.leaving) {
      const t = ease((now - actor.since) / DURATION);
      if (t >= 1) { this.leaving.delete(key); continue; }
      result.push({ source: actor.source, motion: { alpha: 1 - t, lift: t * -5, exiting: true } });
    }
    return result;
  }
  retained(): LiveSource[] { return [...this.leaving.values()].map(actor => actor.source); }
  sceneAlpha(now: number): number { return .72 + .28 * ease((now - this.sceneSince) / DURATION); }
  pending(now: number): boolean {
    return now - this.sceneSince < DURATION || this.leaving.size > 0 || [...this.active.values()].some(actor => now - actor.since < DURATION);
  }
}
