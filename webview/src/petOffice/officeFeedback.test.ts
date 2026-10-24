import { describe, expect, it } from 'vitest';
import { OfficeFeedback, OFFICE_MAX_EFFECTS } from './officeFeedback';
import { liveSceneFixture } from './officeLiveFixtures';
import { parseLiveScene } from './officeLiveModel';
import type { LiveScene } from './officeLiveModel';
import type { OfficePhase } from './officeModel';

function scene(phase: OfficePhase = 'RUNNING', count = 1): LiveScene { return parseLiveScene(liveSceneFixture(Array.from({ length: count }, () => phase))); }

describe('Office-local task feedback', () => {
  it('never replays terminal snapshots on open, reconnect, host replacement or visibility recovery', () => {
    for (const recovery of ['open', 'gap', 'owner', 'epoch', 'hidden'] as const) {
      const feedback = new OfficeFeedback();
      if (recovery !== 'open') feedback.accept(scene(), 0, true);
      const terminal = scene('SUCCEEDED');
      if (recovery === 'owner') terminal.instanceId = 'new-owner';
      if (recovery === 'epoch') terminal.connectionEpoch = 'new-epoch';
      feedback.accept(terminal, recovery === 'gap' ? 15_001 : 100, recovery !== 'hidden');
      expect(feedback.active(200)).toEqual([]);
    }
  });
  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'] as const)('admits %s once and expires without replaying duplicate snapshots', phase => {
    const feedback = new OfficeFeedback(); feedback.accept(scene(), 0, true);
    feedback.accept(scene(phase), 100, true); expect(feedback.active(100)).toHaveLength(1);
    feedback.accept(scene(phase), 1000, true); expect(feedback.active(3100)).toHaveLength(0);
    feedback.accept(scene(phase), 3200, true); expect(feedback.active(3200)).toHaveLength(0);
  });
  it('cancels feedback on a new turn, resolved question, source removal, explicit pause and stale observations', () => {
    const feedback = new OfficeFeedback(); feedback.accept(scene(), 0, true); feedback.accept(scene('FAILED'), 100, true);
    const next = scene(); next.sources[0].turnId = 'next-turn'; feedback.accept(next, 200, true); expect(feedback.active(200)).toEqual([]);
    feedback.accept(scene('WAITING_USER'), 300, true);
    for (let i = 1; i <= 4; i++) feedback.accept(scene('WAITING_USER'), 300 + i * 8000, true);
    expect(feedback.attention(32_300, true, true).size).toBe(1); expect(feedback.active(32_300)).toHaveLength(1);
    feedback.accept(scene(), 32_400, true); expect(feedback.attention(32_400, true, true).size).toBe(0); expect(feedback.active(32_400)).toEqual([]);
    feedback.accept(scene('FAILED'), 32_500, true); feedback.clearEffects(); expect(feedback.active(32_500)).toEqual([]);
    feedback.accept({ ...scene(), sources: [] }, 32_600, true); expect(feedback.active(32_600)).toEqual([]);
    const stale = scene(); stale.sources[0].observationAgeMillis = 15_000;
    feedback.accept(stale, 33_000, true); feedback.accept(scene('SUCCEEDED'), 33_100, true); expect(feedback.active(33_100)).toEqual([]);
  });
  it('debounces the exact pending question, pulses once and restarts for a replacement request', () => {
    const feedback = new OfficeFeedback(); const waiting = scene('WAITING_USER');
    for (let i = 0; i <= 3; i++) feedback.accept(waiting, i * 10_000, true);
    expect(feedback.attention(29_999, true, true).size).toBe(0);
    expect(feedback.attention(30_000, false, true).size).toBe(0);
    expect(feedback.attention(30_000, true, true).size).toBe(1); expect(feedback.active(30_000)).toHaveLength(1);
    feedback.accept(waiting, 40_000, true); expect(feedback.attention(40_000, true, true).size).toBe(1); expect(feedback.active(40_000)).toEqual([]);
    waiting.sources[0].pendingInteractionId = 'replacement'; feedback.accept(waiting, 41_000, true);
    expect(feedback.attention(41_000, true, true).size).toBe(0);
  });
  it('suppresses off-floor effects, cools down simultaneous attention and keeps particles bounded', () => {
    const feedback = new OfficeFeedback(); feedback.accept(scene('RUNNING', 50), 0, true);
    const result = scene('SUCCEEDED', 50); feedback.accept(result, 100, true, new Set()); expect(feedback.active(100)).toEqual([]);
    const bounded = new OfficeFeedback(); bounded.accept(scene('RUNNING', 50), 0, true); bounded.accept(result, 100, true);
    expect(bounded.active(100)).toHaveLength(OFFICE_MAX_EFFECTS);
    const attention = new OfficeFeedback(); const waiting = scene('WAITING_USER', 12);
    for (let i = 0; i <= 3; i++) attention.accept(waiting, i * 10_000, true);
    expect(attention.attention(30_000, true, true).size).toBe(12); expect(attention.active(30_000)).toHaveLength(1);
    expect(attention.attention(45_001, true, true).size).toBe(0); expect(attention.active(45_001)).toEqual([]);
  });
});
