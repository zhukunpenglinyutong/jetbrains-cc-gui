import { describe, expect, it } from 'vitest';
import { OfficeAnimationClock } from './officeAnimation';

function schedulerFixture() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  return {
    pending,
    request: (callback: FrameRequestCallback) => { const id = ++nextId; pending.set(id, callback); return id; },
    cancel: (id: number) => { pending.delete(id); },
    step: (time: number) => {
      const callbacks = [...pending.values()]; pending.clear();
      callbacks.forEach(callback => callback(time));
    },
  };
}

describe('Office scene clock resource lifetime', () => {
  it('holds one RAF for all actors and stops all scheduled work when hidden', () => {
    const scheduler = schedulerFixture();
    let draws = 0;
    const clock = new OfficeAnimationClock(() => { draws++; }, scheduler);
    expect(scheduler.pending.size).toBe(0);
    clock.setActive(true); clock.setActive(true);
    for (let frame = 1; frame <= 120; frame++) {
      expect(scheduler.pending.size).toBe(1);
      scheduler.step(frame * 1000 / 60);
    }
    expect(draws).toBeGreaterThanOrEqual(59);
    expect(draws).toBeLessThanOrEqual(61);
    clock.setActive(false);
    const stopped = draws;
    expect(scheduler.pending.size).toBe(0);
    for (let frame = 121; frame < 240; frame++) scheduler.step(frame * 1000 / 60);
    expect(draws).toBe(stopped);
    expect(clock.getMetrics()).toMatchObject({ running: false, fps: 0 });
  });

  it('resumes with a single clock and cancels pending work on disposal', () => {
    const scheduler = schedulerFixture();
    let draws = 0;
    const clock = new OfficeAnimationClock(() => { draws++; }, scheduler);
    clock.setActive(true); scheduler.step(10); clock.setActive(false);
    clock.setActive(true); scheduler.step(50_000);
    expect(draws).toBe(2);
    expect(scheduler.pending.size).toBe(1);
    clock.dispose(); clock.dispose(); scheduler.step(50_100);
    expect(draws).toBe(2);
    expect(scheduler.pending.size).toBe(0);
  });

  it('keeps its target cadence when RAF callbacks are slightly faster than 30 Hz', () => {
    const scheduler = schedulerFixture();
    let draws = 0;
    const clock = new OfficeAnimationClock(() => { draws++; }, scheduler);
    clock.setActive(true);
    for (let frame = 1; frame <= 100; frame++) scheduler.step(frame * 32);
    expect(draws).toBeGreaterThanOrEqual(95);
    expect(draws).toBeLessThanOrEqual(97);
    expect(scheduler.pending.size).toBe(1);
    clock.dispose();
  });

  it('skips missed intervals without a catch-up draw burst', () => {
    const scheduler = schedulerFixture();
    let draws = 0;
    const clock = new OfficeAnimationClock(() => { draws++; }, scheduler);
    clock.setActive(true);
    scheduler.step(10);
    scheduler.step(3010);
    expect(draws).toBe(2);
    scheduler.step(3020);
    expect(draws).toBe(2);
    scheduler.step(3044);
    expect(draws).toBe(3);
    expect(scheduler.pending.size).toBe(1);
    clock.dispose();
  });
});
