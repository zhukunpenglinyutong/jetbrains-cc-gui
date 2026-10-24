import type { OfficeThemeId } from './officeThemes';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
type Point = readonly [number, number];
type Motion = (node: SVGElement, seconds: number) => void;
interface TravelOptions { opacity?: number; sway?: number; turn?: number; pixel?: boolean }
const number = (value: number) => value.toFixed(2);
const wave = (phase: number) => (1 - Math.cos(phase * TAU)) / 2;

/** Builds a bounded set of SVG actors. The Office clock supplies all animation time. */
class WindowDrawing {
  readonly motions: Motion[] = [];
  readonly theme: OfficeThemeId;
  constructor(theme: OfficeThemeId) { this.theme = theme; }
  id(name: string) { return `office-window-${this.theme}-${name}`; }
  animated(art: string, motion: Motion) {
    const index = this.motions.push(motion) - 1;
    return `<g data-window-motion="${index}">${art}</g>`;
  }
  travel(art: string, from: Point, to: Point, duration: number, phase: number, options: TravelOptions = {}) {
    return this.animated(art, (node, time) => {
      const progress = (time / duration + phase) % 1;
      const x = from[0] + (to[0] - from[0]) * progress + Math.sin(progress * TAU) * (options.sway ?? 0);
      const y = from[1] + (to[1] - from[1]) * progress;
      const coordinate = options.pixel ? Math.round : number;
      node.setAttribute('transform', `translate(${coordinate(x)} ${coordinate(y)}) rotate(${number(progress * (options.turn ?? 0))})`);
      // Smooth fades hide the wrap even when a path starts inside the window.
      const edge = Math.min(1, progress / .09, (1 - progress) / .09);
      node.setAttribute('opacity', number((options.opacity ?? 1) * edge * edge * (3 - 2 * edge)));
    });
  }
  pulse(art: string, duration: number, phase: number, low: number, high: number) {
    return this.animated(art, (node, time) => {
      node.setAttribute('opacity', number(low + wave(time / duration + phase) * (high - low)));
    });
  }
  cloud(scale = 1) {
    return `<g transform="scale(${scale})" fill="url(#${this.id('mist')})"><ellipse rx="116" ry="19"/>
      <ellipse cx="-36" cy="-9" rx="62" ry="21"/><ellipse cx="39" cy="-6" rx="48" ry="16"/></g>`;
  }
  bird(color: string, scale: number, phase: number) {
    const wings = this.animated(`<path d="M-13 0Q-6 -9 0 0Q6 -9 13 0" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`,
      (node, time) => node.setAttribute('transform', `scale(1 ${number(.3 + .7 * Math.sin(time * 2.4 + phase))})`));
    return `<g transform="scale(${scale})">${wings}</g>`;
  }
  definitions(clip?: readonly [number, number, number, number]) {
    const mist = this.theme === 'zen' ? '#eff0df' : '#fff5dc';
    return `<defs><radialGradient id="${this.id('mist')}"><stop stop-color="${mist}" stop-opacity=".72"/>
      <stop offset=".55" stop-color="${mist}" stop-opacity=".4"/><stop offset="1" stop-color="${mist}" stop-opacity="0"/></radialGradient>
      <radialGradient id="${this.id('glow')}"><stop stop-color="#d6f6eb" stop-opacity=".7"/>
      <stop offset="1" stop-color="#a5eadf" stop-opacity="0"/></radialGradient>
      <linearGradient id="${this.id('trail')}" gradientUnits="userSpaceOnUse" x1="-44" y1="0" x2="0" y2="0"><stop stop-color="#9de9ec" stop-opacity="0"/>
      <stop offset="1" stop-color="#e0ffff" stop-opacity=".9"/></linearGradient>
      ${clip ? `<clipPath id="${this.id('clip')}"><rect x="${clip[0]}" y="${clip[1]}" width="${clip[2]}" height="${clip[3]}"/></clipPath>` : ''}</defs>`;
  }
}

function loft(d: WindowDrawing) {
  const clouds = [0, 1, 2, 3].map(i => d.travel(d.cloud(.7 + i * .13), [110, 26 + i * 22], [1050, 26 + i * 22], 48 + i * 9, .12 + i * .23, { opacity: .64 })).join('');
  const birds = [0, 1, 2].map(i => d.travel(d.bird('#73695c', .65 + i * .08, i), [200, 50 + i * 16], [965, 36 + i * 16], 27 + i * 3, .17 + i * .26)).join('');
  return clouds + birds + d.pulse('<ellipse cx="758" cy="34" rx="55" ry="51" fill="#ffe6a9"/>', 11, .25, .02, .12);
}

function cyberpunk(d: WindowDrawing) {
  const rain = Array.from({ length: 64 }, (_, i) => {
    const x = 102 + ((i * 137) % 962), length = 9 + i % 19;
    const streak = `<path d="M0 0l-3 ${length}" fill="none" stroke="${i % 7 ? '#8edeea' : '#ed9fce'}" stroke-width="${i % 4 ? .65 : 1}"/>`;
    return d.travel(streak, [x + 22, -35], [x - 22, 275], 1.8 + (i % 9) * .18, (i * .618) % 1, { opacity: .14 + (i % 5) * .06 });
  }).join('');
  const traffic = [0, 1, 2].map(i => {
    const craft = `<path d="M-43 0H0" stroke="url(#${d.id('trail')})" stroke-width="1.7"/><path d="M-5 -2h10l3 2H-7Z" fill="${i === 1 ? '#ebadd5' : '#b9edf3'}"/>
      <circle cx="-3" cy="1" r="1" fill="#f2d99e"/>`;
    const direction = i === 1 ? 'scale(-1 1)' : '';
    return d.travel(`<g transform="${direction}">${craft}</g>`, [i === 1 ? 1145 : 10, 83 + i * 49], [i === 1 ? 10 : 1145, 75 + i * 49], 14 + i * 5, .24 + i * .24, { opacity: .8 });
  }).join('');
  return rain + traffic;
}

function cultivation(d: WindowDrawing) {
  const mist = [0, 1, 2, 3].map(i => d.travel(d.cloud(2.2 + i * .2), [-300, 119 + i * 34], [1440, 119 + i * 34], 69 + i * 10, .14 + i * .24, { opacity: .54 })).join('');
  const cranes = [0, 1].map(i => d.travel(d.bird('#6b7970', 1.1, i * 2), [-30, 60 + i * 17], [1200, 36 + i * 17], 44, .2 + i * .025, { opacity: .85 })).join('');
  return mist + cranes;
}

function space(d: WindowDrawing) {
  const stars = Array.from({ length: 32 }, (_, i) => {
    const y = 8 + (i * 37) % 96, size = i % 5 === 0 ? 1.6 : .9;
    const halo = i % 5 ? '' : `<circle r="5" fill="url(#${d.id('glow')})"/><path d="M-3 0H3M0 -3V3" stroke="#ceeaff" stroke-width=".65"/>`;
    const star = d.pulse(`${halo}<circle r="${size}" fill="${i % 4 ? '#e0efff' : '#a4dce7'}"/>`, 3.5 + i % 5, i * .27, .3, .95);
    return d.travel(star, [1110, y], [60, y + 10], 32 + (i % 7) * 4, (i * .618) % 1);
  }).join('');
  const comet = `<path d="M-44 -5L0 0" fill="none" stroke="url(#${d.id('trail')})" stroke-width="1.4"/><circle r="1.7" fill="#efffff"/>`;
  return stars + d.travel(comet, [150, -8], [1040, 95], 17, .38, { opacity: .8 });
}

function forest(d: WindowDrawing) {
  const shafts = [210, 610, 940].map((x, i) => d.pulse(`<path d="M${x} 0l-61 269h64L${x + 32} 0Z" fill="#fff3b8"/>`, 13 + i * 3, i * .3, .015, .085)).join('');
  const leaves = Array.from({ length: 17 }, (_, i) => {
    const x = 90 + (i * 173) % 1000;
    const leaf = `<path d="M-5 0Q0 -7 6 0Q0 7 -5 0Z" fill="${['#bed085', '#dccb8e', '#8da768'][i % 3]}" opacity=".8"/><path d="M-4 0H5" stroke="#6e8557" stroke-width=".55"/>`;
    return d.travel(leaf, [x, -24], [x + 67, 288], 18 + (i % 6) * 2.4, (i * .618) % 1, { sway: 14 + i % 8, turn: 210 + i * 11, opacity: .8 });
  }).join('');
  const fireflies = Array.from({ length: 9 }, (_, i) => {
    const x = 120 + (i * 113) % 960;
    const fly = d.pulse(`<circle r="6" fill="url(#${d.id('glow')})"/><circle r="1" fill="#edf5b2"/>`, 3 + i % 4, i * .31, .12, .8);
    return d.travel(fly, [x, 258], [x + 28, 36], 25 + i * 3, i * .107, { sway: 12 });
  }).join('');
  return shafts + leaves + fireflies;
}

function library(d: WindowDrawing) {
  const glints = Array.from({ length: 13 }, (_, i) => {
    const x = 506 + (i * 31) % 150, y = 25 + (i * 53) % 192;
    return d.pulse(`<path d="M${x} ${y - 3}q0 3 3 3q-3 0 -3 3q0 -3 -3 -3q3 0 3 -3Z" fill="#f7e4ad"/>`, 4 + i % 5, i * .21, .03, .88);
  }).join('');
  const sheen = `<ellipse rx="22" ry="155" fill="url(#${d.id('glow')})" transform="rotate(17)"/>`;
  return d.travel(sheen, [452, 110], [706, 110], 22, .33, { opacity: .38 }) + glints;
}

function ocean(d: WindowDrawing) {
  const schools = [0, 1, 2].map(i => {
    const fish = [0, 1, 2, 3].map(j => `<g transform="translate(${-j * 19} ${(j % 2) * 9}) scale(${.8 + j % 2 * .2})">
      <path d="M-9 0l-6 -5v10Z" fill="${i === 1 ? '#b0d4dc' : '#8bcdc5'}"/><ellipse rx="10" ry="3.7" fill="${i === 1 ? '#d5e0c8' : '#b8e3d6'}"/>
      <path d="M-3 -3l3 -3l2 3" fill="#75b8bc"/><circle cx="6" cy="-1" r=".8" fill="#284d60"/></g>`).join('');
    return d.travel(`<g transform="scale(${i === 1 ? '-1 1' : '1 1'})">${fish}</g>`, [i === 1 ? 1200 : -50, 57 + i * 66], [i === 1 ? -50 : 1200, 40 + i * 66], 36 + i * 7, .28 + i * .23, { opacity: .72 });
  }).join('');
  const bubbles = Array.from({ length: 18 }, (_, i) => {
    const x = 110 + (i * 139) % 952;
    return d.travel(`<circle r="${1.3 + i % 4 * .6}" fill="none" stroke="#bfefdf" stroke-width=".7"/><circle cx="-.5" cy="-.6" r=".55" fill="#e3fff2"/>`,
      [x, 275], [x + 7, -24], 13 + i % 7 * 2, (i * .618) % 1, { sway: 5, opacity: .48 });
  }).join('');
  const jelly = `<path d="M-12 0Q-11 -22 0 -22Q11 -22 12 0Q0 6 -12 0Z" fill="#e2c4e1" opacity=".32"/>
    <path d="M-8 1q-6 10 -1 20t-2 16M-2 3q7 12 0 22t2 13M5 2q-4 9 2 18t0 15" fill="none" stroke="#e3d0ea" stroke-width=".8" opacity=".5"/>`;
  return schools + bubbles + d.travel(jelly, [1050, 220], [790, -50], 57, .36, { sway: 18, opacity: .7 });
}

function zen(d: WindowDrawing) {
  const mist = [0, 1].map(i => d.travel(d.cloud(1.7), [155, 171 + i * 35], [1000, 171 + i * 35], 66, .24 + i * .4, { opacity: .26 })).join('');
  const petals = Array.from({ length: 18 }, (_, i) => {
    const x = 370 + (i * 83) % 380;
    const petal = `<path d="M-3 0Q-5 -5 0 -5Q5 -2 2 3Q0 5 -3 0Z" fill="${i % 3 ? '#edbac0' : '#f7ddcf'}"/>`;
    return d.travel(petal, [x, -42], [x + 65, 281], 17 + i % 7 * 2, (i * .618) % 1, { sway: 18, turn: 280 + i * 9, opacity: .78 });
  }).join('');
  return mist + petals;
}

function retro(d: WindowDrawing) {
  const clouds = [0, 1, 2].map(i => d.travel(`<path d="M-21 0v-5h6v-5h14v4h10v3h9v7h-43V0Z" fill="${i === 1 ? '#ecc8c1' : '#d4c4d4'}"/>`,
    [419, 60 + i * 17], [750, 60 + i * 17], 30 + i * 9, .17 + i * .3, { pixel: true, opacity: .62 })).join('');
  const stars = [0, 1, 2, 3, 4].map(i => d.pulse(`<path d="M${464 + i * 48} ${45 + i % 2 * 12}h2v2h-2Z" fill="#ffe5ae"/>`, 3 + i, i * .21, .2, .9)).join('');
  return clouds + stars;
}

interface Mount { parent: Element; before: Element | null; clip?: readonly [number, number, number, number] }
function windowMount(root: SVGSVGElement, theme: OfficeThemeId): Mount | null {
  const backdrop = root.querySelector('[data-depth="backdrop"]');
  if (!backdrop) return null;
  const clipped = (name: string) => backdrop.querySelector(`g[clip-path="url(#office-${theme}-${name})"]`);
  if (theme === 'loft' || theme === 'space') {
    const parent = clipped(theme === 'loft' ? 'skyline-day' : 'earth-sky');
    return parent ? { parent, before: parent.firstElementChild?.nextElementSibling ?? null } : null;
  }
  if (theme === 'cyberpunk' || theme === 'ocean' || theme === 'zen' || theme === 'library') {
    const parent = clipped(theme === 'zen' ? 'moon-gate' : theme === 'library' ? 'stained-window' : 'panorama');
    return parent ? { parent, before: theme === 'library' ? parent.lastElementChild : null } : null;
  }
  // These three original drawings have open scenery instead of a clipped panorama.
  // Insert before the first structural post (or pixel sun), so architecture occludes motion.
  const anchor = theme === 'cultivation' ? 'rect[x="74"][width="20"]'
    : theme === 'forest' ? 'rect[x="49"][width="22"]' : 'rect[x="653.92"][y="61.08"]';
  const before = backdrop.querySelector(anchor);
  const clip: Mount['clip'] = theme === 'cultivation' ? [28, 0, 1104, 248]
    : theme === 'forest' ? [49, 0, 1062, 269] : [448, 40, 264, 124];
  return before?.parentElement === backdrop ? { parent: backdrop, before, clip } : null;
}

const drawings: Record<OfficeThemeId, (drawing: WindowDrawing) => string> = { loft, cyberpunk, cultivation, space, forest, library, ocean, zen, retro };

/** Mounts trusted, local SVG artwork behind window frames. Owns no timers or bitmaps. */
export class OfficeWindowScenery {
  private root: SVGSVGElement | null = null;
  private theme: OfficeThemeId | undefined;
  private group: SVGGElement | null = null;
  private motions: { node: SVGElement; update: Motion }[] = [];
  private lastTime = -1;
  private enabled = false;

  bind(root: SVGSVGElement | null, theme?: OfficeThemeId) {
    if (this.root === root && this.theme === theme) return;
    this.dispose();
    if (!root || !theme) return;
    const mount = windowMount(root, theme);
    if (!mount) return;
    const drawing = new WindowDrawing(theme);
    const art = drawings[theme](drawing);
    const group = root.ownerDocument.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-window-scenery', theme);
    group.setAttribute('pointer-events', 'none');
    group.setAttribute('visibility', 'hidden');
    // Markup is generated only from bundled theme constants, never user content.
    group.innerHTML = drawing.definitions(mount.clip) + (mount.clip ? `<g clip-path="url(#${drawing.id('clip')})">${art}</g>` : art);
    const nodes = [...group.querySelectorAll<SVGElement>('[data-window-motion]')];
    this.motions = nodes.map(node => ({ node, update: drawing.motions[Number(node.getAttribute('data-window-motion'))] }));
    mount.parent.insertBefore(group, mount.before);
    this.root = root; this.theme = theme; this.group = group;
  }

  draw(elapsed: number, enabled: boolean) {
    if (!this.group) return;
    if (this.enabled !== enabled) {
      this.group.setAttribute('visibility', enabled ? 'visible' : 'hidden');
      this.enabled = enabled;
    }
    if (!enabled || elapsed === this.lastTime) return;
    const seconds = Math.max(0, elapsed) / 1000;
    for (const { node, update } of this.motions) update(node, seconds);
    this.lastTime = elapsed;
  }

  dispose() {
    this.group?.remove(); this.group = null; this.root = null; this.theme = undefined;
    this.motions = []; this.lastTime = -1; this.enabled = false;
  }
}
