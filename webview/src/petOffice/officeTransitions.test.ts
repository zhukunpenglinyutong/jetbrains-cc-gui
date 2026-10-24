import { describe, expect, it } from 'vitest';
import type { LiveSource } from './officeLiveModel';
import { OfficeTransitions } from './officeTransitions';

const source = (sourceKey: string, seat: number) => ({ sourceKey, seat } as LiveSource);
describe('Office presentation transitions', () => {
  it('keeps initial and recovered scenes settled, with finite entering and leaving actors', () => {
    const controller = new OfficeTransitions(); const a = source('a', 0), b = source('b', 1);
    controller.sync([a], 'owner/floor', 0, true);
    expect(controller.frame(0)[0].motion.alpha).toBe(1);
    controller.sync([a, b], 'owner/floor', 100, true);
    expect(controller.frame(110)[1].motion.alpha).toBeLessThan(.1);
    expect(controller.frame(400)[1].motion.alpha).toBe(1);
    controller.sync([b], 'owner/floor', 500, true);
    expect(controller.frame(600).find(actor => actor.source.sourceKey === 'a')?.motion.exiting).toBe(true);
    expect(controller.frame(721).map(actor => actor.source.sourceKey)).toEqual(['b']);
    expect(controller.pending(721)).toBe(false);
    controller.sync([a], 'new-owner/floor', 800, true);
    expect(controller.retained()).toEqual([]);
    expect(controller.frame(800)[0].motion.alpha).toBe(1);
  });
  it('retires old hit targets immediately, avoids occupied-seat ghosts and does not replay when motion resumes', () => {
    const controller = new OfficeTransitions();
    controller.sync([source('a', 0)], 'floor', 0, true);
    controller.sync([source('b', 0)], 'floor', 10, true);
    expect(controller.retained()).toEqual([]);
    controller.sync([], 'floor', 20, true);
    expect(controller.retained()).toHaveLength(1);
    controller.sync([], 'floor', 30, false);
    expect(controller.frame(31)).toEqual([]); expect(controller.pending(31)).toBe(false);
    controller.sync([], 'floor', 40, true);
    expect(controller.frame(40)).toEqual([]);
  });
  it('settles a scene fade within 220 ms and caps retiring actors to one floor', () => {
    const controller = new OfficeTransitions();
    controller.sync(Array.from({ length: 50 }, (_, seat) => source(String(seat), seat)), 'a', 0, true);
    controller.sync([], 'a', 10, true); expect(controller.retained()).toHaveLength(12);
    controller.sync([source('next', 1)], 'b', 30, true);
    expect(controller.sceneAlpha(30)).toBe(.72); expect(controller.sceneAlpha(251)).toBe(1);
    expect(controller.retained()).toEqual([]);
  });
});
