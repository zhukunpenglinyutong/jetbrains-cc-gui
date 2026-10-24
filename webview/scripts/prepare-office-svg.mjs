import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Deterministic, hand-authored production artwork. No raster files or local previews are needed.
const directory = fileURLToPath(new URL('../src/petOffice/vector/', import.meta.url));
const N = value => Math.round(value * 100) / 100;
const R = (x, y, w, h, fill, radius = 0, attrs = '') => `<rect x="${N(x)}" y="${N(y)}" width="${N(w)}" height="${N(h)}" rx="${N(radius)}" fill="${fill}" ${attrs}/>`;
const P = (d, fill = 'none', attrs = '') => `<path d="${d}" fill="${fill}" ${attrs}/>`;
const E = (x, y, rx, ry, fill, attrs = '') => `<ellipse cx="${N(x)}" cy="${N(y)}" rx="${N(rx)}" ry="${N(ry)}" fill="${fill}" ${attrs}/>`;
const L = (x, y, xx, yy, color, width = 1, opacity = 1) => P(`M${N(x)} ${N(y)}L${N(xx)} ${N(yy)}`, 'none', `stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round"`);
const G = (x, y, content, scale = 1, attrs = '') => `<g transform="translate(${N(x)} ${N(y)}) scale(${N(scale)})" ${attrs}>${content}</g>`;
const U = (id, x = 0, y = 0, scale = 1, attrs = '') => `<use href="#${id}" transform="translate(${N(x)} ${N(y)}) scale(${N(scale)})" ${attrs}/>`;
const polygon = (points, fill, attrs = '') => `<polygon points="${points.map(p => p.map(N).join(',')).join(' ')}" fill="${fill}" ${attrs}/>`;

const themes = [
  { id: 'loft', name: '暖色阁楼', subtitle: '斜屋顶 · 暖木书墙 · 午后长光', family: 'wood', wall: '#b19a7b', floor: ['#b08a5e', '#785039'], wood: ['#c29a62', '#573b25'], top: ['#d4ae75', '#a5723f'], edge: '#74502e', trim: '#a88245', dark: '#302923', chair: '#6b755d', accent: '#b99b55', sky: ['#b6c7cb', '#f8d9a2'], light: '#ffdf9b' },
  { id: 'cyberpunk', name: '霓虹赛博朋克', subtitle: '雨夜巨幕 · 高架城市 · 工业黑钛', family: 'metal', wall: '#20282d', floor: ['#3e4c58', '#192028'], wood: ['#55616b', '#1c232b'], top: ['#505b63', '#222b33'], edge: '#182128', trim: '#777c78', dark: '#10191f', chair: '#242c32', accent: '#67b8ce', sky: ['#142538', '#557a92'], light: '#ffd89a' },
  { id: 'cultivation', name: '云海仙阁', subtitle: '远山云海 · 青玉雕栏 · 轻纱古木', family: 'antique', wall: '#d9d6c5', floor: ['#989388', '#6b6861'], wood: ['#7d7159', '#393a32'], top: ['#96886c', '#58513e'], edge: '#464335', trim: '#b59d62', dark: '#343d35', chair: '#638978', accent: '#a3b9a2', sky: ['#d6d9d0', '#f7f0dc'], light: '#fff0ca' },
  { id: 'space', name: '星舰指挥舱', subtitle: '轨道地球 · 分舱装甲 · 冷白实验台', family: 'metal', wall: '#5a6365', floor: ['#a6a8a0', '#686d6b'], wood: ['#b0b0a4', '#474d4f'], top: ['#dedbd0', '#8e9591'], edge: '#687173', trim: '#d1c5a0', dark: '#24313b', chair: '#424c51', accent: '#70c9d1', sky: ['#07121e', '#173452'], light: '#fff2cc' },
  { id: 'forest', name: '森林工坊', subtitle: '森林温室 · 斑驳日照 · 苔石与吊篮', family: 'wood', wall: '#9b9870', floor: ['#b58e56', '#795237'], wood: ['#bc9760', '#594326'], top: ['#cba96e', '#916338'], edge: '#755330', trim: '#91845a', dark: '#333d29', chair: '#737c5b', accent: '#95ad69', sky: ['#bcc6a0', '#e9deb2'], light: '#fff2a6' },
  { id: 'library', name: '魔法图书馆', subtitle: '哥特彩窗 · 高书墙 · 古铜与晶石', family: 'antique', wall: '#2c292b', floor: ['#786858', '#403b37'], wood: ['#785333', '#2d2019'], top: ['#a27445', '#4e3425'], edge: '#3b281e', trim: '#b68d48', dark: '#161d27', chair: '#23424a', accent: '#a4a8df', sky: ['#273550', '#5c72a0'], light: '#ffcc76' },
  { id: 'ocean', name: '深海观测站', subtitle: '深海全景 · 黄铜管线 · 水纹冷光', family: 'metal', wall: '#314c59', floor: ['#8c9fa1', '#455f6c'], wood: ['#a7b1ac', '#3d5056'], top: ['#dedbc4', '#8c9c99'], edge: '#667d80', trim: '#b79a6a', dark: '#183844', chair: '#244451', accent: '#7bcfdb', sky: ['#1588af', '#174b69'], light: '#dcf6e8' },
  { id: 'zen', name: '禅意庭院', subtitle: '月洞山水 · 障子与竹影 · 浅木流水', family: 'wood', wall: '#c8c2ae', floor: ['#c9bea4', '#ad9a7c'], wood: ['#dbcca9', '#9c896c'], top: ['#eee0bb', '#c8b394'], edge: '#b5a080', trim: '#8c7b55', dark: '#3a463c', chair: '#b1ad99', accent: '#809173', sky: ['#c0cbd0', '#edf0df'], light: '#fff4d0' },
  { id: 'retro', name: '复古游戏工作室', subtitle: '游戏藏品墙 · CRT 与街机 · 暖灯木地板', family: 'wood', wall: '#978173', floor: ['#ac7d51', '#72492f'], wood: ['#a27b4b', '#4e3829'], top: ['#c99b64', '#926439'], edge: '#6f4a2e', trim: '#b69968', dark: '#292d30', chair: '#7f6b7e', accent: '#b390ac', sky: ['#544d91', '#e7a28f'], light: '#ffd391' },
];

class Drawing {
  constructor(theme) { this.c = theme; this.id = `office-${theme.id}`; this.definitions = []; this.seed = themes.indexOf(theme) * 7963 + 17; }
  random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  fill(name) { return `url(#${this.id}-${name})`; }
  linear(name, colors, x2 = 0, y2 = 1) {
    this.definitions.push(`<linearGradient id="${this.id}-${name}" x1="0" y1="0" x2="${x2}" y2="${y2}">${colors.map((color, i) => `<stop offset="${i / (colors.length - 1)}" stop-color="${color}"/>`).join('')}</linearGradient>`);
    return this.fill(name);
  }
  radial(name, color, opacity = .6) {
    this.definitions.push(`<radialGradient id="${this.id}-${name}"><stop stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`);
    return this.fill(name);
  }
  define(name, content) { this.definitions.push(`<g id="${this.id}-${name}">${content}</g>`); }
  clip(name, content) { this.definitions.push(`<clipPath id="${this.id}-${name}">${content}</clipPath>`); }
  clipped(name, content) { return `<g clip-path="url(#${this.id}-${name})">${content}</g>`; }
  use(name, x = 0, y = 0, scale = 1, attrs = '') { return U(`${this.id}-${name}`, x, y, scale, attrs); }
  pattern(name, width, height, content) {
    this.definitions.push(`<pattern id="${this.id}-${name}" width="${width}" height="${height}" patternUnits="userSpaceOnUse">${content}</pattern>`);
    return this.fill(name);
  }
  initialize() {
    const c = this.c;
    this.linear('floor', c.floor);
    this.linear('wood', [c.wood[1], c.wood[0], c.wood[1]], 1, .16);
    this.linear('desktop', c.top, .2, 1);
    this.linear('gold', ['#493b25', c.trim, '#e6d5a1', c.trim, '#51462e'], 1, .3);
    this.linear('metal', ['#26343e', '#788087', '#a8afaa', '#3b4952', '#293844'], 1, .2);
    this.linear('chair-upholstery', [c.chair, c.chair, c.dark], .5, 1);
    this.linear('sky', c.sky);
    this.linear('glass', ['#79bbc5', '#2b606a', '#629ea7'], 1, .4);
    this.linear('screen', ['#192c3a', '#2b4b59', '#0c1824'], .7, 1);
    this.radial('shadow', '#080d15', .46);
    this.radial('sunlight', c.light, .7);
    this.radial('lamp-glow', c.light, .8);
    this.radial('cool-glow', c.accent, .38);
    this.radial('vignette', '#07101a', .34);
    let grain = '';
    for (let i = 0; i < 11; i++) {
      const y = i * 3.5;
      grain += P(`M-5 ${N(y)}Q24 ${N(y - 4)} 53 ${N(y)}T124 ${N(y + .3)}`, 'none', `stroke="${i % 3 ? '#34271c' : '#fff1d4'}" stroke-width="${i % 4 ? .45 : .9}" opacity="${i % 3 ? .22 : .14}"`);
    }
    this.pattern('grain', 118, 38, grain);
    this.pattern('weave', 7, 7, L(0, 1, 7, 1, '#eedbb1', .7, .22) + L(1, 0, 1, 7, '#211f1a', .5, .15) + E(4, 4, .55, .8, '#d2ba8b', 'opacity=".32"'));
    this.pattern('stone', 152, 110, P('M-10 75Q26 94 44 54T89 47Q110 67 166 28M29 104Q36 77 64 64M44 54L30 25', 'none', 'stroke="#dfded0" stroke-width=".65" opacity=".16"') + P('M0 16Q50 33 84 19T156 10M96 89q26 5 58 -16', 'none', 'stroke="#182129" stroke-width=".6" opacity=".14"'));
    this.pattern('brushed', 70, 18, [1, 4, 8, 11, 15].map((y, i) => L(i * 4, y, 70 - i * 2, y, i % 2 ? '#ffffff' : '#121b25', .45, .11)).join(''));
    this.pattern('bark', 27, 113, P('M4 -2q-3 31 1 51t-2 66M10 -5q7 32 0 54t2 69M22 -2q-4 23 0 41t-1 75M14 13q-4 8 0 15t0 18M5 69q9 10 1 21', 'none', 'stroke="#33432b" stroke-width="1" opacity=".38"') + P('M7 1q-3 26 0 48t-1 63M24 -1q-4 20 0 39t-2 74', 'none', 'stroke="#c3c39a" stroke-width="1" opacity=".4"'));
    const foliage = {
      loft: ['#354433', '#64734c', '#8b9370'], cyberpunk: ['#243c38', '#40564c', '#637567'],
      cultivation: ['#334e43', '#607961', '#8c9b78'], space: ['#354c45', '#607561', '#8e9a7b'],
      forest: ['#304b32', '#5c7345', '#8b985f'], library: ['#283d35', '#4c6046', '#7b8360'],
      ocean: ['#2a4d49', '#567666', '#82a08a'], zen: ['#465c49', '#718169', '#9bA389'],
      retro: ['#344a38', '#5d7250', '#8a956d'],
    }[c.id];
    this.botanicalColors = foliage;
    for (const [index, name] of ['leaf-dark', 'leaf', 'leaf-light'].entries()) {
      this.linear(`foliage-${name}`, [foliage[Math.max(0, index - 1)], foliage[index], foliage[Math.max(0, index - 1)]], 1, .25);
      this.define(name, P('M0 0C-10 -8 -12 -24 2 -39C16 -26 14 -9 0 0Z', this.fill(`foliage-${name}`))
        + P('M0 -1Q3 -18 2 -36', 'none', `stroke="${foliage[2]}" stroke-width=".55" opacity=".5"`));
    }
    this.linear('ceramic', c.family === 'metal' ? ['#2c393b', '#69756e', '#354647'] : ['#67674f', '#b5ad8a', '#85846b'], 1, .15);
    this.define('pot', this.pottedPlant());
    this.define('pot-slim', this.pottedPlant(true));
    this.define('indoor-tree', this.indoorTree());
    this.define('grass', this.grass());
    this.define('fern', this.fern());
    this.define('lantern', this.lantern());
    this.define('lamp', this.deskLamp());
    this.define('armillary', this.armillary());
    this.define('chair', this.chair());
    this.define('desk', this.desk());
  }
  foliage(x, y, size = 1, count = 16, spread = 1) {
    let s = '';
    const stems = [[-23, -36, -9], [3, -61, 8], [29, -46, 12], [-35, -21, -16], [38, -24, 14]];
    for (let i = 0; i < count; i++) {
      const [endX, endY, bend] = stems[i % stems.length], t = Math.min(.94, .42 + Math.floor(i / stems.length) * .23);
      const xx = (2 * (1 - t) * t * bend + t * t * endX) * spread, yy = 2 * (1 - t) * t * -32 + t * t * endY;
      if (i < stems.length) s += P(`M0 0Q${bend * spread} -32 ${endX * spread} ${endY}`, 'none', `stroke="${this.botanicalColors[0]}" stroke-width="1.2"`);
      const angle = (i % 2 ? 49 : -62) + Math.sin(i * 2.7) * 21;
      s += this.leaf(xx, yy, angle, .38 + (i * 7 % 9) / 45, .8, i % 3);
    }
    return G(x, y, s, size);
  }
  leaf(x, y, angle, length = 1, width = 1, shade = 1) {
    return `<g transform="translate(${N(x)} ${N(y)}) rotate(${N(angle)}) scale(${N(length * width)} ${N(length)})">${this.use(['leaf-dark', 'leaf', 'leaf-light'][shade % 3])}</g>`;
  }
  pottedPlant(slim = false) {
    // The origin is the supporting surface, including the contact shadow.
    const plant = slim ? this.grass() : this.foliage(0, -31, .78, 15, .85);
    return E(3, 1, 25, 7, this.fill('shadow')) + P('M-19 -30Q-20 -13 -13 -2Q0 3 13 -2Q20 -13 19 -30Z', this.fill('ceramic'))
      + E(0, -30, 19, 6, '#969b7f') + E(0, -30, 16, 4, '#353c2d')
      + (slim ? G(0, -30, plant, .65) : plant)
      + P('M-19 -30Q0 -23 19 -30', 'none', 'stroke="#c4bda0" stroke-width="1" opacity=".65"');
  }
  indoorTree() {
    let s = E(3, 0, 27, 8, this.fill('shadow')) + P('M-21 -37L-16 -3Q0 3 16 -3L21 -37Z', this.fill('ceramic')) + E(0, -37, 21, 7, '#91917a') + E(0, -37, 18, 4.7, '#353c2d');
    s += P('M-2 -38Q-11 -72 -1 -100Q4 -123 -5 -149M-4 -72Q-27 -82 -31 -105M-1 -97Q23 -110 27 -130M-1 -115Q-21 -124 -24 -140', 'none', 'stroke="#5c5c40" stroke-width="2.8"');
    for (const [x, y, angle, length, shade] of [[-27, -95, -60, .7, 0], [-30, -106, -21, .77, 1], [-20, -91, 58, .62, 0], [-11, -120, -68, .73, 1], [-23, -137, -42, .62, 2], [-2, -135, 24, .75, 1], [5, -102, 62, .7, 0], [20, -118, 51, .78, 1], [26, -130, 12, .65, 2], [-5, -150, -22, .54, 1]]) s += this.leaf(x, y, angle, length, .85, shade);
    return s + P('M-21 -37Q0 -30 21 -37', 'none', 'stroke="#c3b89a" stroke-width="1" opacity=".65"');
  }
  grass() {
    let s = '';
    for (const [x, h, bend] of [[-15, 54, -26], [8, 77, 16], [-5, 88, -9], [20, 47, 36], [-21, 39, -40], [1, 64, 8], [15, 58, 26], [-11, 71, -20], [4, 44, -3]]) {
      s += P(`M0 0Q${bend} ${-h * .6} ${x} ${-h}Q${bend + 4} ${-h * .47} 3 -1Z`, this.botanicalColors[Math.abs(x) % 3]);
    }
    return s;
  }
  fern() {
    let s = '';
    const fronds = [[-60, -12, -31, -49], [-42, -43, -9, -69], [-18, -68, 3, -64], [8, -76, -11, -55], [32, -57, 3, -65], [54, -31, 23, -54], [59, 3, 44, -35]];
    for (const [i, [x, y, cx, cy]] of fronds.entries()) {
      s += P(`M0 0Q${cx} ${cy} ${x} ${y}`, 'none', `stroke="${this.botanicalColors[1]}" stroke-width="1"`);
      for (let j = 1; j < 10; j++) {
        const t = j / 11, xx = 2 * (1 - t) * t * cx + t * t * x, yy = 2 * (1 - t) * t * cy + t * t * y;
        const angle = Math.atan2((1 - t) * cy + t * (y - cy), (1 - t) * cx + t * (x - cx)) * 180 / Math.PI + 90;
        const length = .24 + Math.sin(t * Math.PI) * .23;
        s += this.leaf(xx, yy, angle - 66, length, .36, (i + j) % 2) + this.leaf(xx + .5, yy - 1, angle + 59, length * .9, .36, (i + 1) % 3);
      }
    }
    return s;
  }
  lantern() {
    return E(0, 2, 42, 74, this.fill('lamp-glow')) + L(0, -75, 0, -41, this.c.dark, 2.5) + P('M-21 -37L-15 -44H15L21 -37Z', this.fill('gold')) + R(-17, -34, 34, 48, '#dfbd77', 2) + R(-12, -31, 24, 42, '#fff1bd', 3) + E(0, -10, 10, 19, '#ffdfa0') + [-17, 0, 17].map(x => L(x, -34, x, 15, '#4c4933', 2.5)).join('') + P('M-22 -37L0 -56 22 -37Z', this.fill('wood')) + L(-23, -36, 23, -36, this.c.trim, 2) + R(-22, 14, 44, 6, this.fill('wood'), 2) + E(0, 21, 15, 4, this.fill('gold'));
  }
  deskLamp() {
    return E(0, 5, 32, 12, this.fill('lamp-glow')) + E(0, 1, 13, 5, this.fill('gold')) + L(0, -3, 0, -39, this.c.trim, 2.8) + P('M0 -39Q1 -53 15 -51H27', 'none', `stroke="${this.c.trim}" stroke-width="2.7"`) + E(27, -46, 14, 5, '#ffe6ab') + P('M13 -46Q16 -62 28 -61Q40 -59 42 -46Z', this.fill('gold')) + E(28, -61, 2, 2, '#d9c090');
  }
  armillary() {
    let s = E(0, 10, 28, 7, this.fill('gold')) + P('M-20 7L-11 1 -5 -22H5L11 1 20 7Z', this.fill('gold'));
    for (const angle of [-34, 28, 83]) s += `<ellipse cx="0" cy="-55" rx="41" ry="16" transform="rotate(${angle} 0 -55)" fill="none" stroke="${this.c.trim}" stroke-width="2.7"/>`;
    return s + E(0, -55, 9, 10, this.fill('gold')) + L(-43, -55, 44, -55, '#dcc17c', 1.3) + L(-20, -92, 21, -17, '#dcc17c', 1.5);
  }
  books(x, y, count, scale = 1, height = 35) {
    let s = '', xx = 0;
    const colors = ['#645343', '#7d654b', '#43534d', '#525266', '#855f43', '#383f45', '#987c54', '#665749'];
    for (let i = 0; i < count; i++) {
      const w = 5 + Math.floor(this.random() * 5), h = height - this.random() * 11;
      s += R(xx, -h, w, h, colors[i % colors.length], .7) + R(xx + 1, -h, 1, h, '#e7c99b', 0, 'opacity=".14"');
      s += L(xx + 1, -h + 6, xx + w - 1, -h + 6, '#c1a26d', .8, .7) + L(xx + 1, -5, xx + w - 1, -5, '#c1a26d', .8, .6);
      xx += w + 1.5;
    }
    return G(x, y, s, scale);
  }
  stack(x, y, scale = 1) {
    let s = '';
    for (let i = 0; i < 4; i++) s += R(-22 + i % 2 * 3, -i * 6, 44, 6, ['#685141', '#8b7654', '#4d6559', '#745949'][i], 1) + R(-18 + i % 2 * 3, -i * 6 + 1, 34, 3.5, '#c7b48b', .5);
    return G(x, y, s, scale);
  }
  bookcase(x, y, w, h, style = 'books') {
    const c = this.c, f = this.fill('wood');
    let s = R(x - 4, y + 3, w + 8, h + 3, '#11151a', 1, 'opacity=".35"') + R(x, y, w, h, f, 2) + R(x + 9, y + 10, w - 18, h - 20, c.wood[1]);
    const rows = Math.max(3, Math.floor(h / 44));
    for (let j = 1; j <= rows; j++) {
      const yy = y + 8 + j * (h - 28) / rows;
      s += R(x + 7, yy - 3, w - 14, 7, f, 1) + L(x + 9, yy - 3, x + w - 9, yy - 3, c.trim, .7, .6);
      if (style === 'plants' && j % 2) {
        for (let k = 0; k < Math.floor(w / 34); k++) s += this.use(k % 2 ? 'pot-slim' : 'pot', x + 25 + k * 33, yy - 4, .3 + (k % 2) * .1);
      } else s += this.books(x + 13, yy - 4, Math.floor((w - 26) / 8.5), .95, (h - 28) / rows - 8);
    }
    s += R(x, y - 5, w, 9, f, 1) + R(x - 4, y - 8, w + 8, 5, c.trim, 1) + R(x + 3, y + h - 4, w - 6, 9, f, 1);
    s += R(x + 2, y + 8, 6, h - 12, f) + R(x + w - 8, y + 8, 6, h - 12, f);
    return s;
  }
  cabinet(x, y, w, h, light = false) {
    const c = this.c;
    let s = R(x - 3, y + 7, w + 6, h, '#10171b', 1, 'opacity=".28"') + R(x, y, w, h, light ? this.fill('metal') : this.fill('wood'), 2);
    const n = Math.max(2, Math.floor(w / 47));
    for (let i = 0; i < n; i++) {
      const xx = x + 5 + i * (w - 10) / n, ww = (w - 10) / n - 4;
      s += R(xx, y + 7, ww, h - 16, light ? c.wall : c.wood[1], 1, `stroke="${c.trim}" stroke-width=".7" opacity=".8"`);
      s += R(xx + 4, y + 12, ww - 8, h - 27, light ? c.wall : c.wood[0], .8, 'opacity=".25"');
      s += L(xx + ww - 7, y + h * .4, xx + ww - 7, y + h * .4 + 6, c.trim, 1.7);
    }
    return s + R(x - 5, y - 5, w + 10, 7, light ? this.fill('metal') : this.fill('desktop'), 1) + L(x - 3, y - 5, x + w + 3, y - 5, '#e9dcb8', .8, .5);
  }
  chair() {
    const c = this.c;
    let s = E(2, 52, 48, 14, this.fill('shadow'));
    if (c.family === 'antique') {
      s += P('M-32 -45Q-34 -81 0 -89Q34 -81 32 -45V0H-32Z', this.fill('wood'), `stroke="${c.trim}" stroke-width="2"`) + P('M-25 -43V-64Q0 -88 25 -64V-5H-25Z', this.fill('chair-upholstery'));
      s += P('M-29 -72L-19 -72 -13 -81 0 -85 13 -81 19 -72 29 -72', 'none', `stroke="${c.trim}" stroke-width="1.4"`);
      if (c.id === 'cultivation') s += E(0, -45, 19, 22, '#90aaa0', `stroke="${c.trim}" stroke-width="2"`) + E(0, -45, 14, 17, 'none', 'stroke="#c9d6bc" stroke-width=".8"');
      else s += P('M-13 -61L0 -44 -13 -25M13 -61L0 -44 13 -25', 'none', 'stroke="#142d36" stroke-width="1.7"') + E(0, -44, 2, 3, '#152d33');
      s += R(-29, -9, 58, 15, this.fill('chair-upholstery'), 5) + L(-27, 3, -31, 48, c.wood[1], 5) + L(27, 3, 31, 48, c.wood[1], 5);
    } else {
      s += L(0, 13, 0, 47, '#333b3b', 4) + [-38, -17, 18, 38].map((x, i) => L(0, 43, x, 49 + (i % 2) * 9, '#303638', 3.5)).join('') + [-38, -17, 18, 38].map((x, i) => E(x, 51 + (i % 2) * 9, 4, 3, '#252a2b')).join('');
      s += R(-34, -69, 68, 69, this.fill('chair-upholstery'), 13, `stroke="${c.id === 'zen' ? '#d9d0b8' : '#969582'}" stroke-width="1"`) + R(-28, -64, 56, 52, this.fill('weave'), 10, 'opacity=".8"') + R(-31, -5, 62, 19, this.fill('chair-upholstery'), 6) + P('M-35 -24L-43 -20V-4H-34M35 -24L43 -20V-4H34', 'none', `stroke="${c.id === 'forest' || c.id === 'loft' ? c.edge : '#465353'}" stroke-width="4"`);
      s += P('M-24 -63Q0 -67 25 -63', 'none', 'stroke="#ffffff" stroke-width="1.1" opacity=".22"');
    }
    return s;
  }
  desk() {
    const c = this.c, metal = c.family === 'metal', antique = c.family === 'antique';
    let s = E(8, 44, 111, 34, this.fill('shadow'));
    // Floor-facing panels and legs, then a real, oblique tabletop plane.
    if (metal) {
      for (const x of [-98, 67]) {
        s += R(x, 13, 34, 49, this.fill('metal'), 2, `stroke="${c.dark}" stroke-width="1.2"`);
        for (let j = 0; j < 3; j++) s += R(x + 3, 17 + j * 13, 28, 10, c.wall, 1, `stroke="${c.dark}" stroke-width=".7"`) + L(x + 12, 21 + j * 13, x + 23, 21 + j * 13, c.trim, 1);
        s += R(x + 4, 56, 26, 3, '#18262b', 1);
      }
      s += R(-64, 20, 131, 18, c.dark) + L(-59, 23, 61, 23, c.trim, .65, .3);
    } else if (antique) {
      s += R(-99, 12, 198, 54, this.fill('wood'), 1, `stroke="${c.trim}" stroke-width=".8"`);
      for (const [x, w] of [[-93, 33], [-52, 104], [60, 33]]) s += R(x, 20, w, 38, c.wood[1], 1, `stroke="${c.trim}" stroke-width=".7"`) + R(x + 3, 23, w - 6, 32, c.wood[0], 1, 'opacity=".3"');
      for (const x of [-88, 77]) s += P(`M${x} 55V31Q${x + 6} 20 ${x + 12} 31V55`, 'none', `stroke="${c.trim}" stroke-width="1.2" opacity=".75"`);
      s += L(-98, 64, 98, 64, c.trim, 1.4) + R(-104, 62, 18, 5, this.fill('gold'), 1) + R(87, 62, 18, 5, this.fill('gold'), 1);
    } else {
      for (const x of [-98, 88]) s += polygon([[x, 6], [x + 10, 7], [x + 10, 64], [x + 2, 66]], this.fill('wood'));
      s += R(-90, 18, 180, 12, this.fill('wood'), 1) + R(65, 21, 26, 38, this.fill('wood'), 1);
      if (c.id === 'forest' || c.id === 'retro') for (let j = 0; j < 3; j++) s += R(68, 24 + j * 11, 20, 9, c.wood[1], .8, `stroke="${c.trim}" stroke-width=".6"`) + L(74, 27 + j * 11, 82, 27 + j * 11, '#a29367', 1);
    }
    const points = [[-91, -28], [91, -28], [104, 11], [-104, 11]];
    s += polygon([[-104, 11], [104, 11], [103, 18], [-103, 18]], c.edge);
    s += polygon(points, this.fill('desktop'), `stroke="${metal ? '#a7aca3' : '#d9b375'}" stroke-width=".7"`);
    if (!metal) s += polygon(points, this.fill('grain'), 'opacity=".7"');
    s += L(-102, 11, 102, 11, metal ? '#d7d5b7' : '#f2d197', 1, .6);
    if (c.id === 'cyberpunk') s += L(-96, 16, 95, 16, '#e3b879', 1.1, .8);
    // Clear working area for the animated Pet; props stay to the sides.
    s += polygon([[-41, -17], [40, -17], [44, 4], [-45, 4]], antique ? '#5b6259' : c.id === 'retro' ? '#686079' : metal ? '#899795' : '#76826a', `stroke="${antique ? c.trim : '#a49c7c'}" stroke-width=".7"`);
    if (c.id === 'library') {
      s += this.use('lamp', -69, -12, .55) + this.crystal(76, -21, .62, '#8acfd1');
    } else if (c.id === 'cultivation') {
      s += G(74, -30, R(-10, -26, 20, 31, '#a5bca4', 3, `stroke="${c.trim}" stroke-width="1.5"`) + E(0, -10, 6, 8, 'none', 'stroke="#dce2bb" stroke-width="1.3"') + R(-14, 5, 28, 4, this.fill('gold'), 1));
      s += R(-81, -39, 14, 22, this.fill('gold'), 2) + [-78, -73, -68].map((x, i) => L(x, -26, x + i - 2, -55, '#c4ba91', 1.5)).join('');
    } else {
      s += this.monitor(66, -22, .78, c.id === 'retro');
      if (metal) {
        s += R(-87, -30, 27, 13, c.dark, 2) + R(-82, -46, 5, 22, this.fill('metal'), 1) + R(-72, -48, 6, 24, this.fill('metal'), 1);
        s += L(-86, -24, -86, -52, this.c.trim, 2) + L(-86, -52, -43, -52, this.c.trim, 2.5) + L(-84, -50, -44, -50, this.c.light, 1.6);
      } else if (c.id === 'retro') {
        s += this.use('lamp', -75, -13, .48) + this.gamepad(-58, -9, .55);
      } else {
        s += this.use('pot', -73, -26, .26) + this.stack(-72, -13, .42);
      }
    }
    return s;
  }
  monitor(x, y, scale = 1, crt = false) {
    let s = '';
    if (crt) {
      s = polygon([[-22, -42], [17, -42], [27, -34], [27, -3], [-16, -3], [-22, -8]], '#ad9b80') + R(-19, -39, 40, 34, '#c5b298', 2) + R(-16, -36, 33, 25, '#1c273b', 2) + this.pixelLandscape(-14, -34, 29, 20) + R(-9, -3, 22, 5, '#a6977d', 1) + E(17, -7, 1, 1, '#d1bb7b');
    } else {
      s = polygon([[-23, -46], [24, -43], [23, -10], [-24, -12]], '#1c242a', 'stroke="#778187" stroke-width="1"') + polygon([[-20, -43], [21, -40], [20, -14], [-21, -16]], this.fill('screen')) + P('M-14 -20Q-5 -34 10 -30', 'none', `stroke="${this.c.accent}" stroke-width=".9" opacity=".4"`) + L(-16, -18, -6, -18, '#a5c1c6', .6, .6) + R(-3, -11, 5, 11, '#363f40', 1) + E(0, 1, 13, 3, this.fill('metal'));
    }
    return G(x, y, s, scale);
  }
  crystal(x, y, scale = 1, color = '#a288e2') {
    return G(x, y, E(0, 3, 29, 17, this.fill('cool-glow')) + E(0, 3, 17, 6, this.fill('gold')) + polygon([[-10, -8], [-8, -31], [0, -48], [11, -29], [10, -7], [0, 1]], color, 'stroke="#d9c5e8" stroke-width=".8"') + polygon([[0, -48], [2, -8], [10, -7], [11, -29]], '#edf7ee', 'opacity=".32"') + polygon([[-8, -31], [2, -8], [0, 1], [-10, -8]], '#393d7c', 'opacity=".38"'));
  }
  gamepad(x, y, scale = 1) {
    return G(x, y, P('M-20 -4Q-27 -3 -27 8Q-24 17 -16 11L-9 6H9L16 11Q24 17 27 8Q27 -3 20 -4Z', '#92948d', 'stroke="#394349" stroke-width="1"') + R(-17, -3, 5, 12, '#313c43', 1) + R(-20, 0, 11, 5, '#313c43', 1) + E(15, 1, 2.6, 2.6, '#ae685c') + E(21, 5, 2.4, 2.4, '#8e9b7c') + R(-4, 2, 8, 2, '#394349', 1));
  }
  pixelLandscape(x, y, w, h) {
    let s = R(x, y, w, h, '#6d6b99');
    s += R(x, y + h * .32, w, h * .68, '#b47f9c') + R(x, y + h * .53, w, h * .47, '#d5a2a4') + R(x + w * .78, y + h * .17, w * .08, h * .13, '#f8d79b');
    for (let layer = 0; layer < 3; layer++) {
      const points = [[x, y + h]];
      for (let i = 0; i <= 18; i++) points.push([x + w * i / 18, y + h * (.46 + layer * .15) - Math.sin(i * 1.72 + layer) * h * .18]);
      points.push([x + w, y + h]);
      s += polygon(points, ['#5c5986', '#3b506a', '#273b4b'][layer]);
    }
    s += polygon([[x + w * .45, y + h * .62], [x + w * .57, y + h * .62], [x + w * .68, y + h], [x + w * .3, y + h]], '#ac99c0', 'opacity=".65"');
    return s;
  }
}

function seats() {
  return Array.from({ length: 12 }, (_, i) => {
    const row = Math.floor(i / 4), scale = .84 + row * .08;
    const x = N(580 + ([184, 416, 744, 976][i % 4] - 580) * scale), y = 333 + row * 235;
    return { x, y, scale: N(scale), half: N(106 * scale), front: N(y + 11 * scale), bottom: N(y + 66 * scale), label: N(y + 79 * scale) };
  });
}

function floor(d) {
  const c = d.c, metal = c.family === 'metal', y0 = 248;
  let s = R(0, 0, 1160, 1040, c.dark) + R(0, y0, 1160, 792, d.fill('floor'));
  // A single vanishing point establishes depth across architecture, rugs and floor.
  const projectX = (x, y) => 580 + (x - 580) * (.66 + (y - y0) / 792 * .46);
  let ys = [y0];
  for (let i = 1; i <= (metal ? 12 : 32); i++) ys.push(y0 + Math.pow(i / (metal ? 12 : 32), 1.14) * 792);
  for (let j = 0; j < ys.length - 1; j++) {
    const y = ys[j], yy = ys[j + 1];
    s += L(0, y, 1160, y, metal ? '#101b23' : c.wood[1], metal ? 1 : .65, metal ? .46 : .48) + L(0, y + 1, 1160, y + 1, metal ? '#edf2e4' : '#ffe8b8', .6, .17);
    const cols = metal ? 8 : 7;
    for (let i = 0; i < cols; i++) {
      const x = (i - (j % 2) * .46) * (1160 / cols);
      s += L(projectX(x, y), y, projectX(x, yy), yy, c.dark, .8, .3);
      if (metal && (i + j) % 3 === 0) s += E(projectX(x, y) + 4, y + 4, 1.1, .9, c.trim, 'opacity=".5"');
    }
  }
  s += R(0, y0, 1160, 792, d.fill(metal ? 'brushed' : c.id === 'cultivation' ? 'stone' : 'grain'), 0, 'opacity=".6"');
  if (c.id === 'library' || c.id === 'cultivation') s += R(0, y0, 1160, 792, d.fill('stone'), 0, 'opacity=".8"');
  const carpet = c.id === 'library' ? '#2d344b' : c.id === 'cultivation' ? '#dbd7c2' : c.id === 'zen' ? '#b4ad97' : c.id === 'retro' ? '#657675' : '#72816a';
  if (!metal) {
    s += polygon([[541, 258], [619, 258], [647, 982], [513, 982]], carpet, 'opacity=".83"');
    s += polygon([[546, 264], [614, 264], [639, 975], [521, 975]], 'none', `stroke="${c.id === 'zen' ? '#c7c0aa' : c.trim}" stroke-width="1.1" opacity=".8"`);
    s += polygon([[550, 267], [610, 267], [633, 971], [527, 971]], 'none', `stroke="${c.trim}" stroke-width=".8" opacity=".65"`);
    s += polygon([[541, 258], [619, 258], [647, 982], [513, 982]], d.fill('weave'), 'opacity=".55"');
    if (c.id !== 'zen' && c.id !== 'retro') for (let j = 0; j < 12; j++) {
      const y = 298 + j * 55, w = 18 + j * .8;
      s += G(580, y, P(`M0 -${N(w)}L${N(w * .65)} 0 0 ${N(w)} ${N(-w * .65)} 0Z`, 'none', `stroke="${c.trim}" stroke-width=".8" opacity=".6"`) + E(0, 0, 6, 7, 'none', `stroke="${c.trim}" stroke-width=".6" opacity=".6"`));
    }
  } else {
    for (const x of [526, 634]) {
      s += polygon([[580 + (x - 580) * .72, 257], [580 + (x - 580) * .72 + 5, 257], [x + 9, 983], [x, 983]], '#15242f', 'opacity=".4"');
      for (let y = 288; y < 950; y += 84) s += L(projectX(x, y), y, projectX(x, y + 20), y + 20, c.id === 'cyberpunk' ? '#e4c58d' : c.accent, 1.5, .8);
    }
    if (c.id === 'ocean') {
      for (let i = 0; i < 8; i++) s += P(`M${70 + i * 146} 252q-80 40 0 64t0 64t0 64`, 'none', 'stroke="#b7e7dd" stroke-width="2.3" opacity=".12"');
      s += E(580, 281, 560, 100, d.fill('cool-glow'));
    }
  }
  for (const seat of seats()) {
    const ss = seat.scale, x = seat.x, y = seat.y;
    const rug = c.id === 'library' ? '#263748' : c.id === 'cultivation' ? '#777a6d' : c.id === 'zen' ? '#aea68e' : metal ? '#263a44' : c.id === 'retro' ? '#9b8272' : '#ab9972';
    s += G(x, y, polygon([[-107, -38], [107, -38], [124, 91], [-124, 91]], rug, `stroke="${c.id === 'library' || c.id === 'cultivation' ? c.trim : c.edge}" stroke-width="1" opacity="${metal ? .45 : .78}"`) + polygon([[-101, -33], [101, -33], [117, 85], [-117, 85]], 'none', `stroke="${c.trim}" stroke-width=".8" opacity=".6"`) + polygon([[-105, -37], [105, -37], [121, 89], [-121, 89]], d.fill('weave'), 'opacity=".6"'), ss);
  }
  // Broad, transparent shafts carry the lighting direction from the reference.
  if (['loft', 'forest', 'cultivation', 'zen'].includes(c.id)) {
    for (const [x, w] of [[492, 35], [615, 61], [785, 26], [934, 43]]) s += polygon([[x, 220], [x + w, 220], [x - 210, 986], [x - 250 - w, 986]], c.light, 'opacity=".12"');
    s += E(693, 607, 430, 310, d.fill('sunlight'), 'opacity=".22"');
  }
  return s;
}

function wallBase(d) {
  const c = d.c;
  return R(0, 0, 1160, 259, c.wall) + polygon([[0, 0], [93, 0], [93, 255], [0, 639]], d.fill('wood')) + polygon([[1067, 0], [1160, 0], [1160, 639], [1067, 255]], d.fill('wood')) + L(93, 0, 93, 254, c.trim, 2, .6) + L(1067, 0, 1067, 254, c.trim, 2, .6);
}

function city(d, x, y, width, height, night = false) {
  let s = R(x, y, width, height, d.fill('sky'));
  const clip = `skyline-${night ? 'night' : 'day'}`;
  d.clip(clip, R(x, y, width, height, 'white'));
  if (!night) {
    s += E(x + width * .78, y + height * .25, 29, 29, '#f8e2ac', 'opacity=".9"');
    for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 26; i++) {
      const xx = x + i * width / 24 - 24, w = 15 + d.random() * 29, h = 22 + d.random() * height * .43, yy = y + height - h + layer * 16;
      const colors = [['#a8b5b3', '#bcc0b0'], ['#ac9b85', '#b6aa8e'], ['#b79771', '#ae8668']][layer];
      s += R(xx, yy, w, h, colors[i % 2]) + P(`M${N(xx - 3)} ${N(yy)}L${N(xx + w / 2)} ${N(yy - 10)} ${N(xx + w + 3)} ${N(yy)}Z`, colors[(i + 1) % 2]);
      if (i % 7 === 0) s += R(xx + w * .4, yy - 33, w * .22, 33, colors[0]) + P(`M${N(xx + w * .34)} ${N(yy - 33)}l${N(w * .17)} -18 ${N(w * .17)} 18Z`, '#8e8b7d');
      for (let j = 0; j < 3; j++) s += R(xx + 4 + j * 7, yy + 7, 3, 6, '#e3c998', .6, 'opacity=".7"');
    }
  } else {
    s += polygon([[x + width * .43, y + height * .38], [x + width * .59, y + height * .38], [x + width * .78, y + height], [x + width * .24, y + height]], '#6497ac', 'opacity=".35"');
    for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 30; i++) {
      const xx = x + i * width / 27 - 30 + layer * 8, w = 10 + d.random() * 24, h = 34 + d.random() * height * (.55 + layer * .12), yy = y + height - h;
      s += R(xx, yy, w, h, ['#2d4961', '#20374c', '#172d40'][layer]) + R(xx + 1, yy + 2, 2, h - 3, '#97bdc4', 0, 'opacity=".22"');
      if (i % 5 === 0) s += L(xx + w * .5, yy, xx + w * .5, yy - 14 - d.random() * 23, '#81a2ac', .7, .6);
      for (let j = 0; j < h / 8 - 1; j++) for (let k = 0; k < Math.floor(w / 6); k++) if (d.random() > .36) s += R(xx + 3 + k * 6, yy + 4 + j * 8, 2.1, 2.2, (j + i) % 7 ? '#72c4db' : '#e5a0c7', 0, `opacity="${N(.25 + d.random() * .5)}"`);
      if (i % 8 === 0) {
        const color = i % 3 ? '#d68ab7' : '#75dbeb';
        s += R(xx + 3, yy + 13, 5, h * .4, color, 1, 'opacity=".7"');
        for (let j = 0; j < 4; j++) s += L(xx + 4, yy + 17 + j * 7, xx + 7, yy + 17 + j * 7, '#eef4ef', .7, .7);
        s += L(xx - 3, y + height - 6, xx + w + 10, y + height - 7, color, 2, .26);
      }
    }
    s += P(`M${N(x - 15)} ${N(y + height * .62)}Q${N(x + width * .4)} ${N(y + height * .3)} ${N(x + width + 20)} ${N(y + height * .74)}`, 'none', 'stroke="#182b3b" stroke-width="11"') + P(`M${N(x - 15)} ${N(y + height * .6)}Q${N(x + width * .4)} ${N(y + height * .28)} ${N(x + width + 20)} ${N(y + height * .72)}`, 'none', 'stroke="#a77da4" stroke-width="1.6" opacity=".8"');
    for (let i = 0; i < 250; i++) {
      const xx = x + d.random() * width, yy = y + d.random() * height;
      s += L(xx, yy, xx - .5, yy + 2 + d.random() * 9, '#d2e8eb', .5, .12 + d.random() * .18);
    }
  }
  return d.clipped(clip, s);
}

function mountains(d, x, y, width, height, clouds = false) {
  let s = R(x, y, width, height, d.fill('sky'));
  for (let layer = 0; layer < 5; layer++) {
    const base = y + height * (.5 + layer * .1), step = width / 13;
    const color = ['#aebdb8', '#96aaa3', '#7e978e', '#6c867b', '#597666'][layer];
    for (let i = -1; i < 14; i++) {
      const xx = x + i * step + d.random() * step * .6, hh = height * (.15 + d.random() * .26) * (1 - layer * .08), ww = step * (.8 + d.random() * .6);
      let ridge;
      if (clouds) ridge = `M${N(xx - ww * .6)} ${N(base + 35)}Q${N(xx - ww * .4)} ${N(base - hh * .28)} ${N(xx - ww * .27)} ${N(base - hh * .54)}L${N(xx - ww * .19)} ${N(base - hh * .57)}Q${N(xx - ww * .08)} ${N(base - hh * .86)} ${N(xx)} ${N(base - hh)}L${N(xx + ww * .1)} ${N(base - hh * .88)}Q${N(xx + ww * .18)} ${N(base - hh * .93)} ${N(xx + ww * .23)} ${N(base - hh * .59)}L${N(xx + ww * .35)} ${N(base - hh * .51)}Q${N(xx + ww * .37)} ${N(base - hh * .1)} ${N(xx + ww * .65)} ${N(base + 35)}Z`;
      else ridge = `M${N(xx - ww)} ${N(base + 30)}Q${N(xx - ww * .66)} ${N(base - hh * .3)} ${N(xx - ww * .28)} ${N(base - hh * .65)}Q${N(xx)} ${N(base - hh * 1.1)} ${N(xx + ww * .25)} ${N(base - hh * .62)}Q${N(xx + ww * .65)} ${N(base - hh * .2)} ${N(xx + ww)} ${N(base + 30)}Z`;
      s += P(ridge, color, `opacity="${clouds ? .6 : .8}"`);
      if (clouds) for (let j = 0; j < 3; j++) s += P(`M${N(xx + j * ww * .08)} ${N(base - hh * (.7 - j * .07))}q${N(-ww * .18)} ${N(hh * .22)} ${N(-ww * .13)} ${N(hh * .4)}t${N(-ww * .13)} ${N(hh * .3)}`, 'none', `stroke="${layer % 2 ? '#d0d3bd' : '#496d61'}" stroke-width=".8" opacity=".3"`);
      if (clouds && layer > 1 && i % 3 === 0) s += P(`M${N(xx)} ${N(base - hh + 2)}q-8 -5 -13 -2m9 -7 -1 15m-3 -2q12 -5 17 -3`, 'none', 'stroke="#48685b" stroke-width="1.7" opacity=".75"');
    }
    if (clouds) {
      let cloud = '';
      for (let i = 0; i < 30; i++) {
        const xx = x + i * width / 29 + d.random() * 13, yy = base + 11 + d.random() * 15;
        cloud += E(xx, yy + 5, 38 + d.random() * 35, 14 + d.random() * 8, '#d9e0d6') + E(xx - 6, yy - 1, 26 + d.random() * 27, 8 + d.random() * 8, '#eff0e5');
      }
      s += `<g opacity="${.66 + layer * .04}">${cloud}</g>`;
    }
  }
  return s;
}

function smallPainting(d, x, y, w, h) {
  return R(x - 4, y - 4, w + 8, h + 8, d.fill('wood'), 1, `stroke="${d.c.trim}" stroke-width="1"`) + R(x, y, w, h, '#b8b49a') + polygon([[x, y + h], [x, y + h * .7], [x + w * .24, y + h * .42], [x + w * .54, y + h * .7], [x + w * .8, y + h * .28], [x + w, y + h * .6], [x + w, y + h]], '#7a866e') + polygon([[x, y + h], [x + w * .4, y + h * .72], [x + w * .7, y + h * .88], [x + w, y + h * .69], [x + w, y + h]], '#556756');
}

function loftArchitecture(d) {
  let s = wallBase(d);
  s += city(d, 262, -20, 636, 215);
  for (const x of [264, 420, 574, 730, 886]) s += R(x, -10, 10, 215, d.fill('wood')) + L(x + 8, 1, x + 8, 201, '#d2af72', 1, .6);
  s += R(266, 78, 627, 6, d.fill('wood')) + R(255, 197, 652, 10, d.fill('wood'));
  s += d.cabinet(267, 214, 625, 47);
  for (let i = 0; i < 6; i++) s += d.books(282 + i * 102, 251, 10, .9, 24);
  for (const [x, sc] of [[325, .7], [525, .35], [765, .4], [841, .55]]) s += d.use('pot', x, 203, sc);
  s += d.use('armillary', 652, 204, .47) + d.stack(700, 203, .8) + d.use('lamp', 814, 202, .7);
  s += d.bookcase(144, 48, 100, 217) + d.bookcase(919, 48, 100, 217);
  for (const x of [184, 982]) s += d.use('pot', x, 40, .42) + trailingVine(d, x + 3, 26, .55);
  // Draped linen, not a flat white rectangle.
  for (const [x, mirror] of [[249, false], [909, true]]) {
    const curtain = P('M0 -10H58Q34 74 35 141Q28 189 48 230H-4Q6 170 10 137Q16 71 0 -10Z', '#e2d6b7');
    s += `<g transform="translate(${x} 0) scale(${mirror ? -1 : 1} 1)">${curtain}${[8, 17, 25, 34, 44].map((xx, i) => P(`M${xx} -8Q${xx + 15} 85 ${26 + i * 2} 145T${xx + 3} 226`, 'none', `stroke="${i % 2 ? '#ab9877' : '#fff1cf'}" stroke-width="${i % 2 ? 1 : 2}" opacity=".5"`)).join('')}${P('M12 145Q26 150 38 143', 'none', 'stroke="#b59861" stroke-width="3"')}</g>`;
  }
  // Pitched roof and skylights frame the scene like the source artwork.
  s += polygon([[0, 0], [304, 0], [129, 224], [0, 261]], '#725136') + polygon([[856, 0], [1160, 0], [1160, 261], [1031, 224]], '#725136');
  s += polygon([[8, 0], [266, 0], [120, 207], [8, 241]], d.fill('grain')) + polygon([[894, 0], [1152, 0], [1152, 241], [1040, 207]], d.fill('grain'));
  for (const mirror of [false, true]) {
    let side = polygon([[25, 53], [167, 24], [88, 174], [8, 202]], '#d1b080', 'stroke="#432d20" stroke-width="5"') + polygon([[35, 59], [154, 34], [79, 165], [20, 186]], d.fill('sky'));
    side += L(105, 47, 50, 176, '#87633b', 4) + L(24, 115, 120, 90, '#87633b', 4) + polygon([[29, 64], [71, 54], [26, 173], [18, 180]], '#fff0bc', 'opacity=".65"');
    side += P('M-10 18L220 -20M39 0L-4 101M205 0L89 225M278 -15L123 226', 'none', `stroke="${d.c.wood[1]}" stroke-width="15"`) + P('M211 1L95 225M284 -15L129 226', 'none', 'stroke="#b68a53" stroke-width="2" opacity=".6"');
    s += mirror ? `<g transform="translate(1160 0) scale(-1 1)">${side}</g>` : side;
  }
  s += R(565, 0, 22, 211, d.fill('wood')) + E(576, -7, 48, 42, d.fill('wood')) + E(576, -7, 39, 33, d.fill('sky')) + L(576, -40, 576, 27, '#80613f', 6);
  s += smallPainting(d, 104, 267, 45, 60) + smallPainting(d, 1014, 267, 45, 60);
  s += d.use('indoor-tree', 66, 395, .94) + d.use('indoor-tree', 1095, 390, .8) + d.use('pot', 238, 257, .53);
  return s;
}

function futureWindow(d, content, sea = false) {
  const c = d.c;
  d.clip('panorama', P('M122 13H1038L1063 37V210L1041 238H119L97 210V37Z', 'white'));
  let s = wallBase(d) + d.clipped('panorama', content);
  s += P('M122 7H1038L1071 35V211L1043 246H117L89 211V35Z', 'none', `stroke="${c.dark}" stroke-width="18"`) + P('M122 13H1038L1063 37V210L1041 238H119L97 210V37Z', 'none', `stroke="${sea ? '#597c86' : '#9d9f91'}" stroke-width="3"`);
  for (const x of [358, 802]) {
    s += R(x - 9, 10, 18, 230, d.fill('metal'), 3) + R(x - 4, 13, 8, 224, c.dark, 1) + R(x - 2, 86, 4, 36, '#e9d9a8', 1) + E(x, 101, 22, 54, d.fill('lamp-glow'), 'opacity=".35"');
    for (const y of [28, 220]) s += E(x, y, 2, 2, c.trim);
  }
  s += d.cabinet(114, 248, 932, 31, true);
  for (const x of [130, 314, 500, 685, 870]) s += L(x, 263, x + 64, 263, sea ? '#b4d8d3' : '#ebce95', 1.5, .6);
  return s;
}

function industrialSides(d, sea = false) {
  const c = d.c;
  let s = '';
  for (const mirror of [false, true]) {
    let side = polygon([[0, 0], [90, 18], [90, 280], [0, 609]], c.wall, `stroke="${c.dark}" stroke-width="3"`);
    for (let j = 0; j < 6; j++) side += polygon([[5, 44 + j * 63], [83, 40 + j * 43], [83, 75 + j * 43], [5, 98 + j * 63]], d.fill('metal'), `stroke="${c.dark}" stroke-width="1.4"`) + L(10, 50 + j * 63, 77, 46 + j * 43, '#d2d4b9', .7, .35);
    side += L(29, 7, 29, 293, c.dark, 11) + L(29, 7, 29, 293, sea ? '#ae8e5c' : '#6d7779', 6) + L(27, 8, 27, 293, '#e7cf9c', 1.2, .6);
    for (let y = 39; y < 291; y += 67) side += R(21, y, 16, 5, d.fill('gold'), 1);
    if (sea) {
      side += P('M56 111Q82 102 82 140V270L50 346Q28 372 20 338V193Q22 156 56 111Z', c.dark, `stroke="${c.trim}" stroke-width="2.8"`);
      side += P('M55 125Q73 118 73 148V266L47 329Q32 346 30 325V196Q31 162 55 125Z', '#657779', 'stroke="#a4aa98" stroke-width="1"');
      side += E(52, 234, 14, 23, d.fill('metal'), 'stroke="#242d32" stroke-width="2.3"') + E(52, 234, 9, 15, 'none', `stroke="${c.trim}" stroke-width="1.3"`) + L(52, 215, 52, 253, '#b6b8a5', 1) + L(40, 234, 64, 234, '#b6b8a5', 1);
    } else {
      side += R(46, 82, 37, 166, '#111d26', 2, `stroke="${c.trim}" stroke-width="1"`);
      for (let j = 0; j < 9; j++) side += R(50, 89 + j * 17, 28, 14, '#23313c', 1) + R(55, 93 + j * 17, 3, 2, '#61c2db', .4) + R(61, 93 + j * 17, 3, 2, '#61c2db', .4) + L(54, 100 + j * 17, 74, 100 + j * 17, '#4c747e', .6, .6);
      side += R(45, 20, 38, 40, d.fill('metal'), 2) + E(64, 40, 14, 14, '#15222b', 'stroke="#7a827c" stroke-width="1"');
      for (let j = 0; j < 5; j++) side += `<path d="M64 27Q77 34 67 40Q60 49 54 46Q52 34 64 27Z" fill="#3c4c54" transform="rotate(${j * 72} 64 40)"/>`;
    }
    for (const y of [69, 260]) side += L(13, y, 13, y + 47, '#f1c58e', 2, .8);
    s += mirror ? `<g transform="translate(1160 0) scale(-1 1)">${side}</g>` : side;
  }
  return s;
}

function cyberArchitecture(d) {
  let s = futureWindow(d, city(d, 96, 0, 968, 246, true));
  s += industrialSides(d);
  for (const x of [136, 299, 462, 685, 848, 1011]) s += L(x, 7, x + 80, 7, '#8bd7e5', 2.5, .8) + E(x + 40, 10, 68, 17, d.fill('cool-glow'));
  for (const x of [165, 406, 754, 995]) s += E(x, 425, 35, 175, d.fill('lamp-glow'), 'opacity=".16"') + E(x, 650, 28, 95, d.fill('cool-glow'), 'opacity=".25"');
  s += metalPlanter(d, 121, 284, .6) + metalPlanter(d, 1039, 284, .52);
  return s;
}

function pagoda(d, x, y, scale = 1) {
  return G(x, y, R(-7, -18, 14, 18, '#6b7e70') + P('M-15 -18Q-10 -16 0 -26Q10 -16 15 -18L11 -13H-11Z', '#4d6e60') + R(-6, -35, 12, 14, '#7f9380') + P('M-14 -34Q-8 -33 0 -43Q8 -33 14 -34L10 -29H-10Z', '#527464') + L(0, -47, 0, -39, '#5a7466', 1.5), scale);
}

function bonsai(d, x, y, scale = 1) {
  // Every container is anchored at its bottom, on the supporting surface.
  let s = E(2, 2, 33, 7, d.fill('shadow')) + P('M-28 -12L-23 -1Q0 4 23 -1L28 -12Z', '#50685b')
    + E(0, -12, 28, 6, '#80917a') + E(0, -13, 24, 4, '#394c3e');
  s += P('M-5 -13Q-21 -23 -5 -39Q14 -51 9 -77M-8 -33Q-29 -35 -30 -51M3 -51Q24 -45 35 -58', 'none', 'stroke="#4b4936" stroke-width="5.5" stroke-linecap="round"')
    + P('M-4 -15Q-15 -23 -2 -38Q16 -52 10 -74', 'none', 'stroke="#938467" stroke-width="1.6"');
  for (const [xx, yy, width, height] of [[-29, -52, 25, 10], [10, -78, 28, 10], [36, -59, 22, 8], [-3, -34, 18, 7]]) {
    let crown = P('M-27 3Q-30 -2 -21 -5Q-24 -10 -14 -9Q-10 -16 -3 -10Q5 -16 11 -10Q21 -14 23 -6Q32 -3 27 3Q13 8 -1 6Q-16 10 -27 3Z', d.botanicalColors[0])
      + P('M-25 -1Q-13 -9 -2 -5Q8 -12 20 -4Q10 0 -1 -1Q-15 4 -25 -1Z', d.botanicalColors[1]);
    for (let i = 0; i < 15; i++) {
      const nx = -23 + i * 3.2, ny = -1 - Math.sin(i * 1.7) * 3;
      crown += L(nx, ny, nx - 2, ny - 4, d.botanicalColors[2], .65, .7) + L(nx, ny, nx + 3, ny - 3, d.botanicalColors[1], .7, .8);
    }
    s += `<g transform="translate(${xx} ${yy}) scale(${N(width / 29)} ${N(height / 10)})">${crown}</g>`;
  }
  s += P('M-28 -12Q0 -6 28 -12', 'none', 'stroke="#b1bba2" stroke-width="1.1"');
  return G(x, y, s, scale);
}

function trailingVine(d, x, y, scale = 1) {
  let s = '';
  for (const [offset, height, bend] of [[-7, 66, -13], [5, 91, 14], [13, 49, 19]]) {
    s += P(`M${offset} 0Q${bend} ${N(height * .43)} ${offset + 5} ${height}`, 'none', `stroke="${d.botanicalColors[0]}" stroke-width="1.2"`);
    for (let i = 1; i < 6; i++) {
      const t = i / 6, xx = (1 - t) ** 2 * offset + 2 * (1 - t) * t * bend + t * t * (offset + 5), yy = height * t;
      s += d.leaf(xx, yy, i % 2 ? 133 : -126, .24 + (i % 3) * .04, .8, i % 3);
    }
  }
  return G(x, y, s, scale);
}

function metalPlanter(d, x, y, scale = 1) {
  const c = d.c;
  let s = E(2, 2, 35, 9, d.fill('shadow')) + polygon([[-28, -53], [23, -53], [29, -3], [-24, 0]], '#283c40')
    + polygon([[23, -53], [32, -58], [37, -9], [29, -3]], '#172c32')
    + polygon([[-28, -53], [-20, -59], [32, -58], [23, -53]], '#5c706a')
    + polygon([[-23, -54], [-18, -57], [26, -57], [22, -54]], '#1d302a');
  s += G(1, -55, d.grass(), .82) + d.foliage(-7, -54, .98, 15, .9)
    + L(-26, -52, 23, -52, '#83958a', .9, .6) + L(-20, -8, 19, -10, c.accent, 1.2, .5);
  return G(x, y, s, scale);
}

function carvedRail(d, x, y, w, h = 34) {
  let s = R(x, y, w, h, d.fill('wood')) + R(x + 9, y + 9, w - 18, h - 18, d.c.chair, 1) + R(x + 17, y + 13, w - 34, h - 26, '#5a6f5e', 1, 'opacity=".7"');
  s += R(x - 3, y - 3, w + 6, 6, d.fill('gold'), 1) + L(x + 8, y + h - 4, x + w - 8, y + h - 4, d.c.trim, 1);
  for (const xx of [x, x + w - 10]) s += R(xx, y - 17, 10, h + 19, d.fill('wood'), 1, `stroke="${d.c.trim}" stroke-width=".6"`) + E(xx + 5, y - 21, 7, 9, '#a5c3a3', `stroke="${d.c.trim}" stroke-width="1"`);
  return s;
}

function cultivationArchitecture(d) {
  const c = d.c;
  let s = wallBase(d) + mountains(d, 28, 0, 1104, 248, true) + E(725, 47, 19, 19, '#fffae1');
  for (const [x, y, scale] of [[560, 52, .7], [307, 96, .45], [870, 84, .42], [763, 134, .3]]) s += pagoda(d, x, y, scale);
  s += R(0, 0, 1160, 17, d.fill('wood')) + R(0, 21, 1160, 4, d.fill('gold'));
  for (const x of [84, 378, 782, 1076]) {
    s += R(x - 10, -2, 20, 258, d.fill('wood')) + R(x - 14, 239, 28, 14, d.fill('wood')) + L(x - 7, 14, x - 7, 240, c.trim, 1, .6);
    const bracket = P('M0 0H68V12H50V24H34V38H16V52H0', 'none', `stroke="${c.wood[1]}" stroke-width="8"`) + P('M3 4H63V10H47V23H31V35H14V48', 'none', `stroke="${c.trim}" stroke-width="1.5"`);
    s += G(x + 7, 15, bracket, .9) + `<g transform="translate(${x - 7} 15) scale(-.9 .9)">${bracket}</g>`;
  }
  for (const [x, width, color] of [[122, 84, '#efe6cc'], [221, 41, '#9eaf9c'], [274, 69, '#ede7d3'], [819, 69, '#ede7d3'], [901, 41, '#9eaf9c'], [955, 84, '#efe6cc']]) {
    s += R(x, 7, width, 190, color, 0, 'opacity=".65"') + R(x + 5, 7, width - 10, 190, d.fill('weave'), 0, 'opacity=".45"') + R(x - 3, 196, width + 6, 4, d.fill('gold'), 1);
    if (width < 45) s += E(x + width / 2, 75, 13, 17, 'none', `stroke="${c.trim}" stroke-width=".8" opacity=".5"`);
    else s += P(`M${x + 10} 123q13 -18 25 0t25 0m-40 -22q20 -25 39 0m-41 42q22 20 42 0`, 'none', 'stroke="#b3a98a" stroke-width="1" opacity=".5"');
  }
  for (const x of [67, 1093]) s += d.use('lantern', x, 84, .72);
  for (const [x, w] of [[93, 283], [399, 362], [784, 283]]) s += carvedRail(d, x, 228, w, 36);
  s += d.cabinet(407, 225, 346, 31) + bonsai(d, 689, 220, .72) + bonsai(d, 181, 225, .61) + d.use('armillary', 982, 219, .6);
  for (const x of [380, 780]) s += d.use('lantern', x, 224, .67);
  s += d.bookcase(996, 116, 76, 126) + smallPainting(d, 15, 142, 52, 140) + smallPainting(d, 1093, 142, 52, 140);
  s += bonsai(d, 49, 334, .95) + bonsai(d, 1111, 334, .78);
  return s;
}

function earth(d) {
  d.clip('earth-sky', R(96, 0, 968, 246, 'white'));
  d.linear('planet', ['#729cac', '#456d8f', '#1e4667'], 0, 1);
  let s = R(96, 0, 968, 250, d.fill('sky'));
  for (let i = 0; i < 145; i++) s += E(99 + d.random() * 967, d.random() * 140, i % 11 ? .6 : 1.2, i % 11 ? .6 : 1.2, '#d2e0d8', `opacity="${N(.2 + d.random() * .6)}"`);
  s += E(527, 490, 790, 392, '#9cd8e5') + E(527, 494, 790, 392, d.fill('planet'));
  for (let i = 0; i < 95; i++) {
    const x = 140 + d.random() * 790, y = 119 + d.random() * 124, w = 12 + d.random() * 65;
    const limit = 494 - 392 * Math.sqrt(Math.max(0, 1 - ((x - 527) / 790) ** 2));
    if (y < limit + 6) continue;
    s += P(`M${N(x)} ${N(y)}q${N(w * .4)} -7 ${N(w)} -3t${N(w * .4)} 3q${N(-w * .6)} 8 ${N(-w)} 2Z`, '#c8d6d2', `opacity="${N(.2 + d.random() * .45)}"`);
  }
  s += E(965, 54, 12, 12, '#9c9c89') + E(970, 51, 11, 11, '#182e45');
  s += G(919, 109, E(0, 0, 49, 13, 'none', 'stroke="#b0b6ad" stroke-width="1.8"') + E(0, 0, 35, 9, 'none', 'stroke="#5d7788" stroke-width="1"') + R(-6, -39, 12, 78, '#a9b5b0', 1) + P('M-3 -52L3 -52 6 42H-6Z', '#607b88') + L(-44, -4, 43, 7, '#bbc9c1', 2) + R(-27, -22, 18, 4, '#7a94a0') + R(9, 19, 24, 4, '#7a94a0'), .8);
  return d.clipped('earth-sky', s);
}

function spaceArchitecture(d) {
  let s = futureWindow(d, earth(d)) + industrialSides(d);
  for (const mirror of [false, true]) {
    let side = polygon([[0, 0], [183, 0], [111, 35], [0, 105]], '#4e5758', 'stroke="#b0b2a3" stroke-width="2"') + P('M6 29L105 0M15 75L160 0', 'none', 'stroke="#26343c" stroke-width="9"') + L(16, 67, 121, 8, '#e5dbc1', 2.4, .9);
    s += mirror ? `<g transform="translate(1160 0) scale(-1 1)">${side}</g>` : side;
  }
  for (const x of [272, 564, 856]) s += R(x - 54, 0, 108, 12, '#313e42', 2) + R(x - 40, 3, 80, 4, '#e7debd', 1) + E(x, 10, 100, 35, d.fill('lamp-glow'), 'opacity=".25"');
  s += d.use('pot', 201, 243, .7) + d.use('pot', 1032, 243, .55) + d.use('armillary', 939, 243, .42) + d.books(857, 245, 5, .65, 32) + d.stack(419, 245, .65);
  return s;
}

function forestView(d) {
  let s = R(0, 0, 1160, 269, d.fill('sky'));
  for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 22; i++) {
    const x = i * 60 + d.random() * 23 - 40, w = 7 + layer * 5 + d.random() * 9;
    const colors = ['#9ba989', '#849379', '#576c52'];
    const trunk = `M${N(x)} 265Q${N(x + w)} 124 ${N(x - 3)} -5H${N(x + w + 4)}Q${N(x + w + 7)} 115 ${N(x + w)} 265Z`;
    s += P(trunk, colors[layer], `opacity="${.5 + layer * .15}"`) + P(trunk, d.fill('bark'), 'opacity=".65"');
    s += P(`M${N(x + w * .5)} 71q-17 -17 -24 -48m23 65q19 -27 32 -48`, 'none', `stroke="${colors[layer]}" stroke-width="${1 + layer * 1.6}"`);
  }
  for (let i = 0; i < 94; i++) {
    const x = d.random() * 1160, y = d.random() * 150 - 55, scale = .25 + d.random() * .6;
    s += G(x, y, d.foliage(0, 0, 1, 7, 1.6), scale, `opacity="${N(.22 + d.random() * .4)}"`);
  }
  for (let i = 0; i < 22; i++) s += d.use('fern', 20 + i * 54, 245 + d.random() * 10, .55 + d.random() * .35);
  for (let i = 0; i < 225; i++) {
    const x = d.random() * 1160, y = d.random() * 260;
    if (y > 58 && y < 175 && i % 3) continue;
    const color = ['#5a7746', '#9aa05c', '#78954e', '#c4bd74', '#436b41'][i % 5];
    s += P(`M${N(x)} ${N(y)}q-6 -9 -10 -4q1 7 10 4q6 -9 11 -6q-2 8 -11 6Z`, color, `opacity="${N(.32 + d.random() * .38)}"`);
  }
  for (const [x, w] of [[411, 24], [572, 46], [748, 20], [951, 32]]) s += polygon([[x, -10], [x + w, -10], [x - 98, 264], [x - 148, 264]], '#fff2bc', 'opacity=".19"');
  return s;
}

function stoneWall(d, x, y, w, h) {
  let s = R(x, y, w, h, '#77755a');
  const rows = Math.ceil(h / 24);
  for (let j = 0; j < rows; j++) for (let i = 0; i < Math.ceil(w / 44) + 1; i++) {
    const xx = x + i * 44 - j % 2 * 24, yy = y + j * 24, ww = 36 + d.random() * 8;
    s += P(`M${N(xx + 3)} ${yy + 2}l${N(ww - 6)} -1 6 10 -5 11 -${N(ww - 8)} 2 -6 -9Z`, ['#a6a183', '#929377', '#b1a786', '#7e856b'][i % 4], 'stroke="#5d6049" stroke-width="1"');
    if ((i + j) % 3 === 0) s += E(xx + ww * .5, yy + 5, ww * .38, 5, '#748349', 'opacity=".6"');
  }
  return s;
}

function hangingBasket(d, x, y, scale) {
  let s = L(0, -78, -24, -1, '#4e5536', 1.1) + L(0, -78, 24, -1, '#4e5536', 1.1) + L(0, -78, 0, 6, '#4e5536', .9) + P('M-25 -2Q-21 28 0 28Q21 28 25 -2Z', '#6d542f');
  for (let i = -20; i <= 20; i += 5) s += P(`M${i} 1q${N(-i * .2)} 15 ${N(-i * .4)} 24`, 'none', 'stroke="#b1975a" stroke-width="1"');
  s += d.foliage(0, -1, .68, 19, 1.6);
  for (let i = 0; i < 6; i++) {
    const xx = -17 + i * 7;
    s += P(`M${xx} 1q${i % 2 ? 11 : -9} 28 3 53`, 'none', 'stroke="#597f3e" stroke-width="1.8"') + G(xx + 3, 35, d.use('leaf-light'), .3);
  }
  return G(x, y, s, scale);
}

function forestArchitecture(d) {
  let s = wallBase(d) + forestView(d);
  s += stoneWall(d, 87, 217, 986, 52);
  for (const x of [60, 393, 768, 1100]) {
    s += R(x - 11, 0, 22, 270, d.fill('wood'), 1) + R(x - 11, 0, 22, 270, d.fill('grain'), 1, 'opacity=".7"') + L(x - 8, 1, x - 8, 264, '#d3b273', 1.2, .65);
    s += P(`M${x} 58l-70 -70m70 70 70 -70`, 'none', `stroke="${d.c.edge}" stroke-width="12"`) + P(`M${x + 2} 53l-65 -65m65 65 65 -65`, 'none', 'stroke="#d0ac6e" stroke-width="1" opacity=".65"');
    s += d.use('lantern', x, 137, .51);
  }
  for (const x of [120, 270, 902, 1043]) s += hangingBasket(d, x, 67, .65 + (x % 2) * .1);
  s += d.bookcase(116, 119, 82, 137) + d.bookcase(957, 120, 90, 137, 'plants') + d.cabinet(467, 226, 226, 40);
  for (const [x, sc] of [[479, .4], [529, .35], [576, .7], [644, .35], [680, .32], [206, .75], [942, .9]]) s += d.use('pot', x, 222, sc);
  s += d.stack(613, 218, .55) + d.use('indoor-tree', 1075, 334, .67) + d.use('pot-slim', 82, 334, .85);
  // Receding glass side walls and potting benches extend the greenhouse.
  for (const mirror of [false, true]) {
    let side = polygon([[0, 0], [64, 0], [64, 272], [0, 564]], '#6d805b', 'opacity=".3"');
    for (let i = 0; i < 5; i++) side += L(7 + i * 12, 0, 7 + i * 12, 528 - i * 53, d.c.edge, 4) + L(10 + i * 12, 0, 10 + i * 12, 519 - i * 53, '#d5ba7d', .9, .6);
    side += polygon([[0, 367], [74, 283], [89, 327], [0, 455]], d.fill('wood'));
    for (let j = 0; j < 6; j++) side += d.use('pot', 8 + j * 12, 365 - j * 14, .4);
    s += mirror ? `<g transform="translate(1160 0) scale(-1 1)">${side}</g>` : side;
  }
  return s;
}

function libraryWindow(d) {
  const outer = 'M484 236V94Q484 14 580 -18Q676 14 676 94V236Z';
  d.clip('stained-window', P(outer, 'white'));
  let s = R(474, -22, 212, 268, d.fill('sky'));
  for (let y = -10; y < 240; y += 29) for (let x = 475; x < 687; x += 26) s += P(`M${x} ${y}l13 -15 13 15 -13 15Z`, ['#8e9cbe', '#848cc7', '#6f91ba', '#a29ac0', '#abb7c5'][(Math.floor(x / 26) + Math.floor(y / 29) + 50) % 5], 'stroke="#465675" stroke-width="1"');
  for (const [x, y, radius] of [[580, 116, 34], [580, 47, 25], [523, 70, 14], [637, 70, 14]]) s += E(x, y, radius, radius, '#8298b3', `stroke="${d.c.trim}" stroke-width="2"`) + E(x, y, radius - 4, radius - 4, 'none', 'stroke="#d7ba79" stroke-width=".9"');
  let star = '';
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8, r = i % 2 ? 10 : 29;
    star += `${i ? 'L' : 'M'}${N(580 + Math.sin(a) * r)} ${N(116 - Math.cos(a) * r)}`;
  }
  s += P(`${star}Z`, '#e0c485', 'stroke="#9f814d" stroke-width="1"') + E(580, 45, 11, 14, '#d7c487') + E(586, 40, 10, 13, '#8298b3');
  s += P('M580 -8V236M484 94Q580 28 676 94M491 183Q580 137 669 183', 'none', 'stroke="#544e53" stroke-width="3"');
  s = d.clipped('stained-window', s);
  s += P(outer, 'none', `stroke="${d.c.wood[1]}" stroke-width="17"`) + P(outer, 'none', 'stroke="#a49372" stroke-width="2"');
  s += E(580, 148, 151, 133, d.fill('cool-glow'), 'opacity=".2"');
  return s;
}

function libraryArchitecture(d) {
  let s = wallBase(d) + R(82, 0, 996, 273, '#242327') + libraryWindow(d);
  for (const [x, w] of [[107, 133], [247, 131], [782, 131], [920, 133]]) s += d.bookcase(x, 1, w, 264);
  for (const [x, mirror] of [[392, false], [768, true]]) {
    let banner = P('M0 29H64V194L32 226 0 194Z', '#26334a', `stroke="${d.c.trim}" stroke-width="1.4"`) + P('M5 33H59V191L32 218 5 191Z', 'none', 'stroke="#ae8b4f" stroke-width=".7"') + E(32, 140, 16, 19, 'none', 'stroke="#b2975d" stroke-width="1.3"') + E(36, 135, 13, 16, '#26334a');
    for (let i = 0; i < 8; i++) banner += L(32 + Math.cos(i * Math.PI / 4) * 4, 101 + Math.sin(i * Math.PI / 4) * 4, 32 + Math.cos(i * Math.PI / 4) * 12, 101 + Math.sin(i * Math.PI / 4) * 12, '#b39862', 1);
    banner += L(-4, 26, 68, 26, '#b39862', 3) + E(-5, 26, 3, 3, '#c2aa73') + E(69, 26, 3, 3, '#c2aa73');
    s += mirror ? `<g transform="translate(${x} 0) scale(-1 1)">${banner}</g>` : G(x, 0, banner);
  }
  s += d.cabinet(477, 235, 206, 40) + d.use('armillary', 580, 227, .78) + d.use('pot', 500, 227, .62) + d.use('pot', 662, 227, .62);
  for (const x of [216, 944]) s += P(`M${x} 31V259m0 -175 27 1v174m-26 -154h26m-26 24h26m-26 24h26m-26 24h26m-26 24h26m-26 24h26`, 'none', `stroke="${d.c.wood[0]}" stroke-width="3.5"`) + L(x + 2, 32, x + 2, 257, d.c.trim, .8, .4);
  for (const [x, scale, color] of [[200, 1.1, '#a18bdf'], [487, .67, '#83c6d5'], [673, .67, '#83c6d5'], [960, 1.1, '#a18bdf']]) {
    s += L(x, 0, x, 56, '#9e8652', 1.2) + d.crystal(x, 108, scale, color) + E(x, 89, 39 * scale, 58 * scale, d.fill('cool-glow'), 'opacity=".5"');
    s += P(`M${N(x - 15 * scale)} ${N(78)}L${x} ${N(51)} ${N(x + 15 * scale)} 78`, 'none', 'stroke="#bba06a" stroke-width="1.2"');
  }
  s += d.use('armillary', 116, 245, .87) + d.stack(116, 270, 1.25) + d.use('lamp', 1040, 247, .8);
  for (const mirror of [false, true]) {
    let side = polygon([[0, 0], [75, 0], [75, 273], [0, 541]], '#35312d') + polygon([[6, 23], [56, 39], [56, 235], [6, 343]], '#3e4c68', 'stroke="#a38d66" stroke-width="3"');
    for (let i = 0; i < 6; i++) side += L(6, 53 + i * 38, 54, 61 + i * 30, '#958ba0', .8, .75);
    side += d.stack(39, 381, 1.2) + d.use('pot-slim', 43, 359.4, .58);
    s += mirror ? `<g transform="translate(1160 0) scale(-1 1)">${side}</g>` : side;
  }
  return s;
}

function kelp(d, x, y, scale = 1) {
  let s = '';
  for (let i = 0; i < 5; i++) {
    const xx = -14 + i * 7, h = 65 + i % 3 * 19;
    s += P(`M${xx} 0q-13 -${N(h * .3)} 0 -${N(h * .55)}t-3 -${N(h * .45)}`, 'none', `stroke="${i % 2 ? '#6b9f76' : '#8da475'}" stroke-width="2"`);
    for (let j = 1; j < 7; j++) s += P(`M${xx} ${-j * h / 8}q${j % 2 ? -15 : 15} -10 ${j % 2 ? -10 : 10} -18q${j % 2 ? 8 : -8} 4 ${j % 2 ? 10 : -10} 18Z`, '#7b9b74', 'opacity=".8"');
  }
  return G(x, y, s, scale);
}

function coral(d, x, y, scale = 1, color = '#c3b69a') {
  let s = '';
  for (let i = 0; i < 9; i++) {
    const xx = -28 + i * 7;
    s += P(`M0 0Q${xx} -10 ${xx} ${-25 - i % 3 * 8}m${-xx * .3} 13q-10 -3 -13 -13m${xx * .3} 1q13 -4 15 -15`, 'none', `stroke="${color}" stroke-width="${i % 2 ? 1.5 : 2.4}" stroke-linecap="round"`);
  }
  return G(x, y, s, scale);
}

function oceanView(d) {
  let s = R(94, 0, 972, 248, d.fill('sky'));
  for (const [x, w] of [[130, 18], [391, 32], [635, 14], [865, 27]]) s += polygon([[x, 0], [x + w, 0], [x - 68, 245], [x - 114, 245]], '#92e0e3', 'opacity=".12"');
  for (let i = 0; i < 15; i++) {
    const x = 106 + i * 70, h = 25 + d.random() * 99;
    s += P(`M${x - 28} 247Q${x - 22} ${N(247 - h * .55)} ${x - 12} ${N(247 - h)}L${x + 6} ${N(238 - h)}Q${x + 20} ${N(246 - h * .5)} ${x + 31} 247Z`, i % 2 ? '#2b6579' : '#285b70');
    s += L(x - 12, 247 - h + 8, x - 10, 230, '#79aaa8', 1, .3);
  }
  for (const [x, y, scale] of [[157, 238, 1.25], [315, 241, .7], [721, 239, 1.18], [977, 239, 1.6]]) s += kelp(d, x, y, scale);
  for (let i = 0; i < 31; i++) {
    const x = 112 + d.random() * 932, y = 202 + d.random() * 46;
    s += coral(d, x, y, .3 + d.random() * .35, ['#baaeb6', '#b4c1aa', '#87b3b1'][i % 3]);
  }
  for (let i = 0; i < 54; i++) {
    const x = 169 + d.random() * 776, y = 30 + d.random() * 150, size = 2 + d.random() * 4;
    s += G(x, y, P('M-5 0Q0 -4 6 0Q0 4 -5 0L-8 -3V3Z', '#87c0c7'), size / 5, 'opacity=".7"');
  }
  s += G(641, 104, P('M-60 0Q-28 -18 6 -10L26 -25 23 -7 70 -5 48 2 27 2 15 22 4 5Q-30 17 -60 0Z', '#2a6680'), 1.05);
  for (let i = 0; i < 46; i++) s += E(110 + d.random() * 940, d.random() * 242, .8 + d.random() * 1.3, .8 + d.random() * 1.3, '#b0d8cf', 'opacity=".22"');
  s += P('M100 15q90 -13 175 0t175 0t175 0t175 0t260 0M100 21q65 -13 145 0t180 0t180 0t180 0t280 0', 'none', 'stroke="#b3e7df" stroke-width="1.3" opacity=".3"');
  return s;
}

function aquarium(d, x, y, scale = 1) {
  let s = E(0, 0, 31, 9, d.fill('metal')) + R(-31, 0, 62, 102, d.fill('glass'), 3, 'opacity=".7"') + E(0, 100, 31, 11, d.fill('metal')) + R(-33, 98, 66, 30, d.fill('metal'), 2) + E(0, 127, 33, 7, d.fill('metal')) + E(0, 0, 31, 9, '#738f92', 'stroke="#afc2ba" stroke-width="1"') + R(-35, -9, 70, 9, d.fill('metal'), 2);
  s += kelp(d, 3, 91, .6) + coral(d, -7, 97, .6, '#d8cdb6') + L(-25, 10, -25, 92, '#b6e6df', 2, .55) + L(21, 10, 21, 94, '#b6e6df', .7, .5);
  return G(x, y, E(2, 1, 36, 8, d.fill('shadow')) + G(0, -134, s), scale);
}

function oceanArchitecture(d) {
  let s = futureWindow(d, oceanView(d), true) + industrialSides(d, true);
  s += coral(d, 780, 244, .68) + aquarium(d, 180, 243, .28) + aquarium(d, 1084, 276, .66) + aquarium(d, 102, 276, .43);
  s += P('M4 6H64Q84 6 84 27V76M1156 6H1096Q1076 6 1076 27V76', 'none', 'stroke="#182c37" stroke-width="11"') + P('M4 6H64Q84 6 84 27V76M1156 6H1096Q1076 6 1076 27V76', 'none', 'stroke="#ac9366" stroke-width="5"') + P('M5 3H64Q82 3 82 27V76M1155 3H1096Q1078 3 1078 27V76', 'none', 'stroke="#d3bc8d" stroke-width="1" opacity=".6"');
  return s;
}

function bamboo(d, x, y, scale = 1) {
  let s = '';
  for (const [i, [xx, h, bend]] of [[-21, 129, -8], [-7, 171, 9], [10, 152, -7], [26, 113, 11]].entries()) {
    s += P(`M${xx} 0Q${xx + bend * .5} ${-h * .5} ${xx + bend} ${-h}`, 'none', `stroke="${d.botanicalColors[i % 2]}" stroke-width="2.6" stroke-linecap="round"`)
      + L(xx + 1, -4, xx + bend + 1, -h + 3, '#a3ac80', .7, .6);
    for (let j = 1; j < 7; j++) {
      const t = j / 7, bx = xx + bend * t, by = -h * t;
      s += L(bx - 1.7, by, bx + 1.7, by, '#a3ad83', 1.1, .8);
      if ((i + j) % 3 !== 0) continue;
      const direction = (i + j) % 2 ? -1 : 1;
      let branch = P('M0 0Q15 -17 38 -23', 'none', `stroke="${d.botanicalColors[0]}" stroke-width=".85"`);
      for (let k = 0; k < 5; k++) {
        const lx = 9 + k * 6, ly = -8 - k * 3.4, angle = k % 2 ? 42 : 113;
        branch += `<g transform="translate(${lx} ${ly}) rotate(${angle})">${P('M0 0Q-4 -14 0 -29Q5 -16 0 0Z', d.botanicalColors[(k + i) % 3])}</g>`;
      }
      s += `<g transform="translate(${N(bx)} ${N(by)}) scale(${direction} 1)">${branch}</g>`;
    }
  }
  return G(x, y, s, scale);
}

function bambooPlanter(d, x, y, scale = 1) {
  return G(x, y, E(2, 1, 28, 7, d.fill('shadow')) + P('M-23 -33Q-24 -12 -16 -2Q0 4 16 -2Q24 -12 23 -33Z', d.fill('ceramic'))
    + E(0, -33, 23, 6.5, '#9da28b') + E(0, -33, 20, 4.5, '#49503b') + bamboo(d, 0, -33, .81)
    + P('M-23 -33Q0 -26 23 -33', 'none', 'stroke="#c4bca1" stroke-width="1"'), scale);
}

function gardenLantern(d, x, y, scale = 1) {
  return G(x, y, E(0, 3, 25, 8, '#5e6756') + R(-9, -28, 18, 30, '#878c74', 2) + P('M-24 -33L-15 -42H15L24 -33Z', '#6a7767') + R(-16, -70, 32, 29, '#87977e', 2) + R(-10, -65, 20, 21, '#d0ce9c', 1) + L(0, -66, 0, -44, '#5b715b', 2) + P('M-31 -70Q-12 -75 0 -92Q12 -75 31 -70L23 -66H-23Z', '#5d7064') + E(0, -94, 4, 5, '#77866f'), scale);
}

function stream(d, x, mirror = false) {
  let s = polygon([[0, 286], [40, 286], [82, 986], [0, 986]], '#546e5d') + P('M4 287Q20 450 20 605T29 981', 'none', 'stroke="#b8c8b0" stroke-width="1" opacity=".5"');
  for (let i = 0; i < 20; i++) {
    const y = 314 + i * 34, xx = i % 2 ? 14 : 43, w = 8 + d.random() * 15;
    s += E(xx, y, w, w * .42, ['#8e9476', '#a5a38a', '#626f59'][i % 3], 'stroke="#b3b299" stroke-width=".7"') + L(xx - w * .6, y - 2, xx + w * .6, y - 3, '#c4c3a6', .65, .6);
    s += E(25 + i % 3 * 10, y + 12, 13, 3, 'none', 'stroke="#c5d7c3" stroke-width=".7" opacity=".45"');
  }
  s += bamboo(d, 16, 419, .7) + d.use('fern', 41, 781, .5);
  return mirror ? `<g transform="translate(${x} 0) scale(-1 1)">${s}</g>` : G(x, 0, s);
}

function zenArchitecture(d) {
  let s = wallBase(d) + R(84, 0, 992, 263, '#c6c2ad') + R(84, 0, 992, 263, d.fill('stone'), 0, 'opacity=".25"');
  d.clip('moon-gate', E(580, 92, 187, 175, 'white'));
  let garden = mountains(d, 388, -12, 384, 270);
  garden += P('M390 250Q580 130 770 250V270H390Z', '#748e75') + P('M572 192Q498 214 575 245L643 270H500Q545 223 544 220Q539 204 572 192Z', '#bdccc0');
  garden += bamboo(d, 445, 241, 1.4) + bamboo(d, 738, 243, 1.18) + gardenLantern(d, 681, 238, .67) + bonsai(d, 533, 224, .62);
  for (let i = 0; i < 16; i++) garden += E(405 + i * 23, 232 + i % 3 * 9, 11 + i % 4 * 3, 7, '#7c8a71');
  s += d.clipped('moon-gate', garden) + E(580, 92, 188, 176, 'none', 'stroke="#887b5d" stroke-width="7"') + E(580, 92, 192, 179, 'none', 'stroke="#d5ccaf" stroke-width="2"');
  for (const x of [238, 780]) {
    s += R(x, 0, 142, 253, '#e2d8bd', 1, 'stroke="#807151" stroke-width="3"');
    for (let xx = x + 29; xx < x + 142; xx += 29) s += L(xx, 0, xx, 253, '#9b8865', 1.6);
    for (let y = 29; y < 253; y += 30) s += L(x, y, x + 142, y, '#9b8865', 1.6);
    s += R(x, 0, 142, 253, d.fill('weave'), 0, 'opacity=".22"');
  }
  s += R(385, 259, 389, 7, '#aaa38b') + bonsai(d, 372, 259, .7);
  s += d.cabinet(114, 230, 135, 38) + d.cabinet(930, 248, 111, 28) + d.use('pot-slim', 201, 225, .63) + d.use('pot', 966, 243, .5);
  s += bambooPlanter(d, 108, 280, .85) + bambooPlanter(d, 1059, 280, 1.03);
  for (const [x, y] of [[127, 100], [1033, 203]]) s += G(x, y, L(0, -75, 0, -34, '#4a4838', 1) + R(-11, -33, 22, 43, '#f9e7b8', 1, 'stroke="#6a6049" stroke-width="2"') + E(0, -12, 25, 55, d.fill('lamp-glow'), 'opacity=".45"'));
  s += stream(d, 0) + stream(d, 1160, true);
  return s;
}

function arcade(d, x, y, scale = 1, mirror = false) {
  let s = P('M-34 5V-74L-21 -89 -22 -126H34V-113L25 -88 40 -30V5Z', '#292b2b', 'stroke="#80644d" stroke-width="1.4"') + R(-20, -124, 52, 15, '#c79a62', 2) + R(-18, -122, 48, 11, '#b96946', 1) + P('M-17 -107L24 -106 31 -62 -24 -62Z', '#171f28') + d.pixelLandscape(-14, -102, 35, 31) + P('M-25 -58H31L38 -37H-31Z', '#73503c') + L(-20, -50, -20, -40, '#d3bb8f', 2) + E(-20, -51, 3, 3, '#c98f63') + E(13, -45, 3, 1.8, '#d38e66') + E(23, -46, 3, 1.8, '#d6a568') + R(-25, -30, 55, 27, '#20282a', 1, 'stroke="#8a6d4e" stroke-width="1"') + R(-8, -22, 19, 9, '#131b20', 1);
  return `<g transform="translate(${x} ${y}) scale(${mirror ? -scale : scale} ${scale})">${s}</g>`;
}

function gameShelf(d, x, y, w, h) {
  let s = d.bookcase(x, y, w, h);
  // Collectible consoles and controllers occupy the lower shelves.
  s += R(x + 9, y + h * .58, w - 18, h * .34, d.c.wood[1]);
  for (let i = 0; i < 3; i++) s += d.gamepad(x + 27 + i * (w - 50) / 2, y + h * .65, .5) + R(x + 11 + i * (w - 25) / 3, y + h * .82, (w - 35) / 3, 16, ['#6e756e', '#9c9580', '#3f4c4e'][i], 2);
  s += L(x + 8, y + h * .71, x + w - 8, y + h * .71, d.c.wood[0], 4);
  return s;
}

function retroArchitecture(d) {
  let s = wallBase(d) + R(93, 0, 974, 267, '#8d7a6a') + R(93, 0, 974, 267, d.fill('grain'), 0, 'opacity=".3"');
  for (const x of [107, 183, 259, 335, 411, 749, 825, 901, 977, 1053]) s += L(x, 0, x, 260, '#4e4037', 1, .25);
  s += R(414, 8, 332, 194, '#483b33', 5, 'stroke="#b59268" stroke-width="3"') + R(427, 21, 306, 169, '#252b31', 8) + R(439, 32, 282, 142, '#111a28', 3) + d.pixelLandscape(448, 40, 264, 124) + R(555, 181, 50, 3, '#6c7067', 1);
  s += d.cabinet(409, 213, 342, 49) + gameShelf(d, 205, 66, 184, 194) + gameShelf(d, 771, 66, 184, 194);
  for (const x of [396, 760]) s += R(x - 12, 155, 25, 48, '#2e3031', 2) + E(x + .5, 181, 8, 11, '#151d23', 'stroke="#6c6d62" stroke-width="1"') + E(x + .5, 166, 4, 5, '#111c22');
  for (const x of [229, 364, 796, 930]) s += d.use('pot', x, 60, .4);
  for (const x of [174, 986]) s += R(x - 7, 37, 14, 21, '#dfb87d', 6) + E(x, 49, 40, 68, d.fill('lamp-glow'), 'opacity=".4"') + L(x, 58, x, 68, '#695439', 2) + E(x, 70, 8, 3, '#715c40');
  for (const x of [120, 989]) s += R(x, 39, 53, 94, '#392f2b', 1, 'stroke="#c2a27d" stroke-width="2"') + d.pixelLandscape(x + 5, 44, 43, 84);
  s += arcade(d, 111, 288, .76) + arcade(d, 1049, 288, .76, true) + d.use('indoor-tree', 76, 390, .72) + d.use('pot-slim', 1086, 390, .9);
  s += R(14, 393, 47, 187, d.fill('wood'), 2) + R(1099, 393, 47, 187, d.fill('wood'), 2);
  for (let i = 0; i < 5; i++) s += d.gamepad(1122, 420 + i * 28, .57) + d.stack(38, 418 + i * 30, .6);
  return s;
}

function entry(d) {
  const c = d.c, tech = c.family === 'metal';
  let s = '';
  const y = 977;
  if (c.id === 'cultivation') {
    for (const x of [0, 774]) s += carvedRail(d, x, y - 4, 386, 41);
    for (const x of [346, 814]) s += d.use('lantern', x, y - 21, .95);
    for (let i = 0; i < 5; i++) s += polygon([[393 - i * 10, y + i * 13], [767 + i * 10, y + i * 13], [777 + i * 10, y + 13 + i * 13], [383 - i * 10, y + 13 + i * 13]], i % 2 ? '#a8afa0' : '#c5c9b6', 'stroke="#7c887b" stroke-width="1"');
    for (const x of [113, 1047]) {
      s += E(x + 3, 1020, 50, 12, d.fill('shadow')) + R(x - 38, 993, 76, 32, '#6f8275', 2)
        + R(x - 43, 988, 86, 6, '#b0bca7', 1) + R(x - 31, 1001, 62, 17, '#839585', 1);
      s += bonsai(d, x, 988, x < 580 ? 1.04 : .9);
      for (let i = 0; i < 7; i++) s += E(x + (i - 3) * 39, 1041 + i % 2 * 3, 52, 21, '#e5eade', 'opacity=".8"');
    }
  } else if (c.id === 'forest') {
    for (const x of [0, 930]) {
      s += stoneWall(d, x, 932, 230, 108) + R(x + 5, 929, 220, 10, '#4c603c', 4)
        + E(x + 83, 934, 69, 7, '#69784a') + E(x + 164, 932, 37, 6, '#7a8353');
      s += d.use('fern', x + (x ? 155 : 62), 935, x ? .87 : 1.02)
        + d.use('fern', x + (x ? 86 : 151), 934, x ? .56 : .44)
        + G(x + (x ? 62 : 163), 933, d.grass(), .42)
        + trailingVine(d, x + (x ? 172 : 82), 934, .69)
        + d.use('lantern', x + (x ? 18 : 212), 918, .7);
      s += L(x + (x ? 5 : 229), 972, x + (x ? -26 : 260), 1040, c.edge, 13) + L(x + (x ? 5 : 229), 972, x + (x ? -26 : 260), 1040, '#c19b60', 2.3, .8);
    }
    for (let i = 0; i < 4; i++) s += polygon([[255 - i * 11, 985 + i * 17], [905 + i * 11, 985 + i * 17], [916 + i * 11, 1002 + i * 17], [244 - i * 11, 1002 + i * 17]], d.fill('wood'), 'stroke="#d4b47c" stroke-width="1"');
  } else if (c.id === 'zen') {
    for (const [x, mirror] of [[65, false], [1095, true]]) {
      let bed = E(0, 1021, 92, 25, '#596750') + E(-5, 1019, 77, 16, '#748063');
      bed += bamboo(d, 1, 1018, mirror ? .78 : .58) + d.use('fern', -29, 1004, .57) + G(39, 1015, d.grass(), .5);
      bed += P('M-67 1039L-75 1007L-63 978L-37 960L-12 969L-7 1017L-22 1038Z', '#7c8274')
        + P('M-63 978L-37 960L-12 969L-31 990L-56 1003L-75 1007Z', '#a4a795')
        + P('M-12 969L-7 1017L-22 1038L-31 990Z', '#626e60')
        + P('M18 1041L11 1019L24 996L52 990L75 1009L73 1040Z', '#8a8e7c')
        + P('M11 1019L24 996L52 990L44 1015Z', '#b2b29b')
        + P('M52 990L75 1009L73 1040L44 1015Z', '#6b7765')
        + E(-44, 1005, 16, 5, '#687951') + E(34, 1020, 19, 5, '#6c7c53');
      s += `<g transform="translate(${x} 0) scale(${mirror ? -1 : 1} 1)">${bed}</g>`;
    }
    s += gardenLantern(d, 157, 1012, 1) + R(223, 985, 714, 10, '#9e9f8f') + R(205, 1005, 750, 14, '#bbbbaa') + R(188, 1030, 784, 10, '#a0a394');
  } else if (tech) {
    // Planters stand behind the glazed rail; the rail occludes their lower stems.
    if (c.id !== 'ocean') s += metalPlanter(d, 62, 1009, 1.02) + metalPlanter(d, 1098, 1009, .9);
    for (const x of [0, 889]) {
      s += R(x, 959, 271, 66, d.fill('metal'), 2) + R(x + 13, 954, 244, 8, c.dark, 2) + R(x + 20, 965, 224, 34, '#76a6ad', 1, 'opacity=".25"') + L(x + 14, 954, x + 255, 954, c.trim, 3);
      for (const xx of [x + 13, x + 256]) s += R(xx - 4, 951, 8, 77, d.fill('metal'), 1) + L(xx - 2, 958, xx - 2, 1018, '#c9d8c8', 1.2, .65);
    }
    s += R(272, 1003, 616, 11, c.dark, 1) + L(284, 1004, 876, 1004, c.id === 'cyberpunk' ? '#ddc38a' : c.accent, 1.8, .8) + R(257, 1024, 646, 15, d.fill('metal'), 1);
    if (c.id === 'ocean') s += aquarium(d, 43, 1008, .78) + aquarium(d, 1117, 1008, .7);
  } else {
    for (const x of [0, 924]) {
      const right = x > 580;
      s += d.cabinet(x - 3, 972, 239, 68);
      if (c.id === 'library') {
        s += d.use('pot-slim', x + (right ? 188 : 46), 967, .68)
          + d.use('armillary', x + (right ? 61 : 179), 960, .7) + d.stack(x + 115, 962.2, .8)
          + trailingVine(d, x + (right ? 184 : 42), 947, .42);
      } else if (c.id === 'retro') {
        s += d.use('indoor-tree', x + (right ? 192 : 48), 967, right ? .7 : .79)
          + d.stack(x + (right ? 79 : 156), 961.6, .9) + d.gamepad(x + (right ? 132 : 105), 960, .53);
      } else {
        s += d.use('indoor-tree', x + (right ? 194 : 48), 967, right ? .77 : .92)
          + d.use('pot', x + (right ? 61 : 191), 967, right ? .5 : .4) + d.stack(x + 130, 961.6, .9);
      }
    }
    s += polygon([[394, 978], [766, 978], [790, 1040], [370, 1040]], c.id === 'library' ? '#253649' : c.id === 'retro' ? '#b79879' : '#955e42', `stroke="${c.trim}" stroke-width="2"`) + polygon([[407, 986], [753, 986], [771, 1037], [389, 1037]], 'none', `stroke="${c.trim}" stroke-width="1.4"`) + P('M580 990L619 1016 580 1042 541 1016Z', c.id === 'library' ? '#8e784b' : '#687971', 'opacity=".8"');
  }
  return `<g data-decoration="entrance" data-depth="entrance">${s}</g>`;
}

function render(theme) {
  const d = new Drawing(theme);
  d.initialize();
  const architecture = { loft: loftArchitecture, cyberpunk: cyberArchitecture, cultivation: cultivationArchitecture, space: spaceArchitecture, forest: forestArchitecture, library: libraryArchitecture, ocean: oceanArchitecture, zen: zenArchitecture, retro: retroArchitecture };
  let environment = floor(d) + `<g data-depth="backdrop">${architecture[theme.id](d)}</g>`;
  for (let row = 0; row < 3; row++) {
    environment += `<g data-depth="row-${row}">${seats().slice(row * 4, row * 4 + 4).map(seat => d.use('chair', seat.x, seat.y - 7 * seat.scale, seat.scale)).join('')}</g>`;
  }
  environment += entry(d);
  // Local ambient shade uses bounded gradients, no SVG filters or raster textures.
  environment += E(-15, 537, 151, 720, d.fill('vignette')) + E(1175, 537, 151, 720, d.fill('vignette'));
  d.define('foreground', [0, 1, 2].map(row => `<g data-depth="row-${row}">${seats().slice(row * 4, row * 4 + 4).map(seat => d.use('desk', seat.x, seat.y, seat.scale)).join('')}</g>`).join(''));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="1040" viewBox="0 0 1160 1040" role="img" aria-labelledby="${d.id}-title"><title id="${d.id}-title">${theme.name} — reference-led vector study</title><defs>${d.definitions.join('')}</defs><g data-layer="environment">${environment}</g>${d.use('foreground')}</svg>\n`;
}

await mkdir(directory, { recursive: true });
let bytes = 0;
for (const theme of themes) {
  const svg = render(theme);
  await writeFile(`${directory}/${theme.id}.svg`, svg);
  bytes += Buffer.byteLength(svg);
}
await writeFile(`${directory}/geometry.json`, `${JSON.stringify(Object.fromEntries(themes.map(theme => [theme.id, seats()])), null, 2)}\n`);
console.log(`Prepared nine SVG rooms: ${bytes.toLocaleString('en-US')} bytes.`);
