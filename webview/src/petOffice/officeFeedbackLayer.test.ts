import { describe, expect, it, vi } from 'vitest';
import { animate } from 'motion/mini';
import { OfficeFeedbackLayer } from './officeFeedbackLayer';

vi.mock('motion/mini', () => ({ animate: vi.fn(() => ({ stop: vi.fn() })) }));
const camera = { x: 100, y: 100, width: 1000, height: 800 };
const hit = { sourceKey: 'ide/tab/binding', x: 200, y: 300, width: 200, height: 200 };
const effect = { sourceKey: hit.sourceKey, identity: 'terminal-1', outcome: 'SUCCEEDED', startedAt: 0, expiresAt: 3000 };
const labels = { SUCCEEDED: '已完成' };

describe('Office Motion feedback layer', () => {
  it('animates each event once while following hit regions and the camera without React updates', () => {
    vi.mocked(animate).mockClear();
    const layer = new OfficeFeedbackLayer(), root = document.createElement('div');
    layer.sync(root, [effect], [hit], camera, 100, labels);
    for (let frame = 0; frame < 30; frame++) layer.sync(root, [effect], [hit], camera, 100 + frame * 33, labels);
    expect(animate).toHaveBeenCalledTimes(1); expect(root.textContent).toBe('✓已完成');
    const anchor = root.firstElementChild as HTMLDivElement;
    expect(anchor.style.left).toBe('20.000%'); expect(anchor.style.top).toBe('28.000%');
    layer.sync(root, [effect], [{ ...hit, x: 300 }], camera, 1200, labels);
    expect(anchor.style.left).toBe('30.000%'); expect(animate).toHaveBeenCalledTimes(1);
    const animation = vi.mocked(animate).mock.results[0].value;
    layer.sync(root, [], [], camera, 1300, labels);
    expect(animation.stop).toHaveBeenCalledOnce(); expect(root.childElementCount).toBe(0);
  });
  it('drops hidden, expired, retired and off-camera events and clears animations on suspension', () => {
    vi.mocked(animate).mockClear();
    const layer = new OfficeFeedbackLayer(), root = document.createElement('div');
    layer.sync(root, [effect], [hit], camera, 10, labels); layer.clear();
    expect(root.childElementCount).toBe(0);
    expect(vi.mocked(animate).mock.results[0].value.stop).toHaveBeenCalledOnce();
    layer.sync(root, [effect], [hit], camera, 3100, labels);
    layer.sync(root, [effect], [], camera, 100, labels);
    layer.sync(root, [effect], [{ ...hit, x: 2100 }], camera, 100, labels);
    layer.sync(null, [effect], [hit], camera, 100, labels);
    expect(root.childElementCount).toBe(0); expect(animate).toHaveBeenCalledTimes(1);
  });
});
