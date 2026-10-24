import { describe, expect, it } from 'vitest';
import { OfficeWindowScenery } from './officeWindowScenery';
import { OFFICE_THEME_IDS } from './officeThemes';
import type { OfficeThemeId } from './officeThemes';

const drawings = import.meta.glob<string>('./vector/*.svg', { eager: true, query: '?raw', import: 'default' });
function room(theme: OfficeThemeId) {
  return new DOMParser().parseFromString(drawings[`./vector/${theme}.svg`], 'image/svg+xml').documentElement as unknown as SVGSVGElement;
}
function frame(root: Element) {
  return [...root.querySelectorAll('[data-window-motion]')].map(node => [node.getAttribute('transform'), node.getAttribute('opacity')]);
}

describe('looping exterior scenery', () => {
  it.each(OFFICE_THEME_IDS)('%s mounts inside the exterior clip and retains bounded actors across frames', theme => {
    const root = room(theme), controller = new OfficeWindowScenery();
    const staticNodes = root.querySelectorAll('*').length;
    controller.bind(root, theme); controller.draw(12_345, true);
    const group = root.querySelector('[data-window-scenery]')!;
    expect(group.getAttribute('data-window-scenery')).toBe(theme);
    expect(group.closest('[data-depth="backdrop"]')).not.toBeNull();
    const motion = [...group.querySelectorAll('[data-window-motion]')];
    expect(motion.length).toBeGreaterThan(4);
    expect(motion.length).toBeLessThanOrEqual(100);
    for (const node of motion) {
      const clip = node.closest('[clip-path]')!;
      const id = clip.getAttribute('clip-path')!.slice(4, -1);
      expect(root.querySelector(id)?.tagName).toBe('clipPath');
    }
    expect(group.querySelector('animate, animateTransform, image, filter, script, foreignObject')).toBeNull();
    const count = root.querySelectorAll('*').length, initial = frame(root);
    for (const time of [13_579, 60_000, 3_600_000, 86_400_000]) {
      controller.draw(time, true);
      expect(root.querySelectorAll('*').length).toBe(count);
      for (const node of motion) {
        expect(node.getAttribute('transform') ?? '').not.toMatch(/NaN|Infinity/);
        if (node.hasAttribute('opacity')) expect(Number(node.getAttribute('opacity'))).toBeGreaterThanOrEqual(0);
        if (node.hasAttribute('opacity')) expect(Number(node.getAttribute('opacity'))).toBeLessThanOrEqual(1);
      }
    }
    expect(frame(root)).not.toEqual(initial);
    controller.bind(root, theme);
    expect(root.querySelector('[data-window-scenery]')).toBe(group);
    expect(root.querySelectorAll('[data-window-scenery]')).toHaveLength(1);
    controller.dispose();
    expect(root.querySelectorAll('*').length).toBe(staticNodes);
  });

  it('puts motion behind the existing frames, posts, moon and planet', () => {
    for (const theme of OFFICE_THEME_IDS) {
      const root = room(theme), controller = new OfficeWindowScenery(); controller.bind(root, theme);
      const group = root.querySelector('[data-window-scenery]')!;
      if (theme === 'loft' || theme === 'space') {
        expect(group.previousElementSibling?.tagName).toBe('rect');
        expect(group.nextElementSibling).not.toBeNull();
      } else if (theme === 'cultivation' || theme === 'forest') {
        expect(group.nextElementSibling?.getAttribute('fill')).toBe(`url(#office-${theme}-wood)`);
      } else if (theme === 'retro') {
        expect(group.nextElementSibling?.getAttribute('fill')).toBe('#f8d79b');
      } else if (theme === 'library') {
        expect(group.nextElementSibling?.getAttribute('stroke')).toBe('#544e53');
      } else {
        expect(group.parentElement?.nextElementSibling?.tagName).toBe(theme === 'zen' ? 'ellipse' : 'path');
      }
      controller.dispose();
    }
  });

  it('freezes with a stopped clock, toggles without mutating the room and releases old theme DOM', () => {
    const root = room('ocean'), next = room('loft'), controller = new OfficeWindowScenery();
    controller.bind(root, 'ocean'); controller.draw(8000, true);
    const active = frame(root), group = root.querySelector('[data-window-scenery]')!;
    controller.draw(8000, true);
    expect(frame(root)).toEqual(active);
    controller.draw(9000, false);
    expect(group.getAttribute('visibility')).toBe('hidden');
    expect(frame(root)).toEqual(active);
    controller.draw(8000, true);
    expect(group.getAttribute('visibility')).toBe('visible');
    expect(frame(root)).toEqual(active);
    controller.bind(next, 'loft'); controller.draw(0, true);
    expect(root.querySelector('[data-window-scenery]')).toBeNull();
    expect(next.querySelector('[data-window-scenery]')?.getAttribute('visibility')).toBe('visible');
    controller.bind(null);
    expect(next.querySelector('[data-window-scenery]')).toBeNull();
    expect(() => controller.draw(10_000, true)).not.toThrow();
  });

  it('fades a rain streak through its exact wrap without a visible jump', () => {
    const root = room('cyberpunk'), controller = new OfficeWindowScenery();
    controller.bind(root, 'cyberpunk'); controller.draw(0, true);
    const streak = root.querySelector('[data-window-motion="0"]')!;
    const start = streak.getAttribute('transform');
    controller.draw(900, true); expect(Number(streak.getAttribute('opacity'))).toBeGreaterThan(0);
    controller.draw(1799, true); expect(Number(streak.getAttribute('opacity'))).toBe(0);
    controller.draw(1800, true);
    expect(streak.getAttribute('transform')).toBe(start);
    expect(Number(streak.getAttribute('opacity'))).toBe(0);
    controller.dispose();
  });

  it('leaves custom backgrounds and missing exterior anchors intact', () => {
    const root = room('loft'), controller = new OfficeWindowScenery();
    const original = root.outerHTML;
    controller.bind(root); controller.draw(1000, true);
    expect(root.outerHTML).toBe(original);
    root.querySelector('[data-depth="backdrop"]')?.remove();
    const missing = root.outerHTML;
    controller.bind(root, 'loft'); controller.draw(1000, true);
    expect(root.outerHTML).toBe(missing);
  });
});
