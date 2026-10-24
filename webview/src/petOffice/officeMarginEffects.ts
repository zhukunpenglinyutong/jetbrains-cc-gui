import type { OfficeUiPalette } from './officePresentation';

export const OFFICE_MARGIN_MODES = ['aurora', 'matrix', 'rain', 'stars', 'snow', 'neon'] as const;
export type OfficeMarginMode = typeof OFFICE_MARGIN_MODES[number];
export interface OfficeMarginPreferences { enabled: boolean; mode: OfficeMarginMode }
export interface OfficeMarginLayout { width: number; height: number; pixelWidth: number; pixelHeight: number }
const KEY = 'ccgui.pet.office.margin-effects.v1';
const DEFAULTS: OfficeMarginPreferences = { enabled: true, mode: 'aurora' };
const TAU = Math.PI * 2;
const GLYPHS = '01<>[]{}+=/:*';

function valid(value: unknown): value is OfficeMarginPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && typeof record.enabled === 'boolean'
    && OFFICE_MARGIN_MODES.some(mode => mode === record.mode);
}

/** Renderer-local decoration is independent of shared session and Pet preferences. */
export function readOfficeMarginPreferences(): OfficeMarginPreferences {
  try {
    const saved = localStorage.getItem(KEY);
    const value: unknown = saved && saved.length <= 96 ? JSON.parse(saved) : null;
    return valid(value) ? value : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}
export function writeOfficeMarginPreferences(value: OfficeMarginPreferences): boolean {
  try { if (!valid(value)) return false; localStorage.setItem(KEY, JSON.stringify(value)); return true; }
  catch { return false; }
}

/** Only spare horizontal space gets a bitmap; the two strips together stay below 4 MiB. */
export function officeMarginLayout(width: number, height: number, sceneWidth: number, dpr: number): OfficeMarginLayout {
  if (![width, height, sceneWidth, dpr].every(value => Number.isFinite(value) && value > 0)) return { width: 0, height: 0, pixelWidth: 1, pixelHeight: 1 };
  const gap = Math.max(0, Math.floor((width - sceneWidth) / 2));
  if (gap < 32) return { width: 0, height: 0, pixelWidth: 1, pixelHeight: 1 };
  const ratio = Math.min(1.5, dpr, Math.sqrt(524_288 / (gap * height)));
  return { width: gap, height, pixelWidth: Math.max(1, Math.floor(gap * ratio)), pixelHeight: Math.max(1, Math.floor(height * ratio)) };
}

function seed(index: number, salt = 0): number {
  const value = Math.sin((index + 1) * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string, alpha: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, color); gradient.addColorStop(1, `${color}00`);
  ctx.globalAlpha = alpha; ctx.fillStyle = gradient; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
}

/** Soft flowing curtains and sparse points of light, inspired by the smoke reference. */
function aurora(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, palette: OfficeUiPalette, side: number) {
  ctx.globalCompositeOperation = 'screen';
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const drift = Math.sin(t * .12 + i * 1.7 + side) * w * .18;
    const x = w * (.08 + i * .26) + drift;
    const gradient = ctx.createLinearGradient(0, h, w * .7, 0);
    gradient.addColorStop(0, `${palette.accent}00`); gradient.addColorStop(.3, palette.accent);
    gradient.addColorStop(.64, palette.muted); gradient.addColorStop(1, `${palette.accent}00`);
    ctx.strokeStyle = gradient;
    // Nested translucent strokes soften the curtain without costly full-height blur filters.
    for (let edge = 0; edge < 7; edge++) {
      ctx.globalAlpha = .012 + edge * .002; ctx.lineWidth = w * (.9 - edge * .11);
      ctx.beginPath(); ctx.moveTo(x - w * .3, h * 1.1);
      ctx.bezierCurveTo(x + w * .9, h * .74, x - w * .7, h * .38, x + w * .12, -h * .1); ctx.stroke();
    }
  }
  for (let i = 0; i < 9; i++) {
    const x = (seed(i, side) * .8 + .1) * w + Math.sin(t * .08 + i) * w * .1;
    const y = (seed(i, side + 3) * h - t * (3 + seed(i) * 5) % (h + 120) + h + 120) % (h + 120) - 60;
    glow(ctx, x, y, 18 + seed(i) * 32, 50 + seed(i, 9) * 60, palette.accent, .08);
  }
  for (let i = 0; i < 32; i++) {
    const x = seed(i, side + 7) * w + Math.sin(t * .22 + i) * 8;
    const y = ((seed(i, 5) * h - t * (5 + seed(i) * 8)) % h + h) % h;
    const pulse = .3 + (Math.sin(t * .7 + i * 2) + 1) * .2;
    ctx.globalAlpha = pulse; ctx.fillStyle = palette.accent;
    ctx.beginPath(); ctx.arc(x, y, .6 + seed(i, 4) * 1.2, 0, TAU); ctx.fill();
    if (i % 6 === 0) glow(ctx, x, y, 6, 6, palette.accent, pulse * .25);
  }
}

function matrix(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, palette: OfficeUiPalette, side: number) {
  const size = 12, spacing = 16, step = 15;
  ctx.font = `${size}px "Cascadia Code", Consolas, monospace`; ctx.textAlign = 'center';
  for (let col = 0; col < Math.ceil(w / spacing); col++) {
    const speed = 28 + seed(col, side + 2) * 44, length = 18 + Math.floor(seed(col, 11) * 18);
    const head = (t * speed + seed(col, side + 10) * (h + length * step)) % (h + length * step);
    for (let row = 0; row < length; row++) {
      const y = head - row * step;
      if (y < -size || y > h + size) continue;
      const index = Math.floor(seed(col * 39 + row + Math.floor(t * 5), side) * GLYPHS.length);
      ctx.fillStyle = row === 0 ? palette.text : palette.accent;
      ctx.globalAlpha = row === 0 ? .85 : Math.pow(1 - row / length, 1.6) * .5;
      ctx.fillText(GLYPHS[index], col * spacing + spacing / 2, y);
    }
  }
}

/** Tapered light curtains share the room clock; travelling highlights stay attached to each fold. */
function neon(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, palette: OfficeUiPalette, side: number) {
  const colors = [palette.accent, '#ab91ff', '#ef9acb'];
  ctx.globalCompositeOperation = 'screen'; ctx.lineCap = 'round';
  for (let ribbon = 0; ribbon < 3; ribbon++) {
    const phase = t * .16 + ribbon * 1.9 + side * 1.3;
    const points = Array.from({ length: 41 }, (_, index) => {
      const progress = index / 40;
      const taper = Math.pow(Math.sin(progress * Math.PI), .8);
      return { y: progress * h,
        x: w * (.19 + ribbon * .3 + Math.sin(progress * TAU * .85 + phase) * .14
          + Math.sin(progress * TAU * 1.4 - phase * .6) * .055),
        width: w * (.16 + Math.sin(progress * TAU + phase) * .035) * taper };
    });
    const color = colors[ribbon], nextColor = colors[(ribbon + 1) % colors.length];
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, `${color}00`); gradient.addColorStop(.2, color);
    gradient.addColorStop(.65, nextColor); gradient.addColorStop(1, `${nextColor}00`);
    ctx.fillStyle = gradient;
    // Nested filled bands feather the fabric, avoiding blur filters and disconnected light blobs.
    for (let layer = 0; layer < 12; layer++) {
      const spread = 1.5 - layer * .11;
      ctx.globalAlpha = .014 + layer * .0018;
      ctx.beginPath();
      for (const [index, point] of points.entries()) {
        const x = point.x - point.width * spread;
        if (index === 0) ctx.moveTo(x, point.y); else ctx.lineTo(x, point.y);
      }
      for (let index = points.length - 1; index >= 0; index--) {
        const point = points[index]; ctx.lineTo(point.x + point.width * spread, point.y);
      }
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = gradient; ctx.globalAlpha = .32; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [index, point] of points.entries()) {
      const x = point.x + point.width * .24;
      if (index === 0) ctx.moveTo(x, point.y); else ctx.lineTo(x, point.y);
    }
    ctx.stroke();
    const progress = (t * .045 + ribbon * .33 + side * .16) % 1;
    const highlight = ctx.createLinearGradient(0, 0, 0, h);
    highlight.addColorStop(0, `${color}00`);
    highlight.addColorStop(Math.max(0, progress - .13), `${color}00`);
    highlight.addColorStop(progress, palette.text);
    highlight.addColorStop(Math.min(1, progress + .13), `${nextColor}00`);
    highlight.addColorStop(1, `${nextColor}00`);
    ctx.strokeStyle = highlight; ctx.globalAlpha = Math.sin(progress * Math.PI) * .55; ctx.lineWidth = 1.6; ctx.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const progress = ((seed(i, 83) - t * (.006 + seed(i) * .006)) % 1 + 1) % 1;
    const x = w * (.1 + seed(i, side + 79) * .8 + Math.sin(progress * TAU + t * .16 + i) * .055);
    ctx.globalAlpha = Math.sin(progress * Math.PI) * (.2 + (Math.sin(t * .5 + i * 2) + 1) * .12);
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath(); ctx.arc(x, progress * h, .6 + seed(i, 89) * .7, 0, TAU); ctx.fill();
  }
}

/** Glass droplets, long rain trails and defocused lights without loading an external wallpaper. */
function rain(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, palette: OfficeUiPalette, side: number) {
  for (let i = 0; i < 8; i++) {
    const x = seed(i, side + 8) * w, y = h * (.25 + seed(i, 17) * .7);
    glow(ctx, x, y, 12 + seed(i) * 26, 14 + seed(i, 2) * 30, i % 3 === 0 ? palette.text : palette.accent, .1);
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 44; i++) {
    const speed = 70 + seed(i, 6) * 110;
    const x = seed(i, side + 19) * w, y = (seed(i, 3) * (h + 100) + t * speed) % (h + 100) - 70;
    const length = 9 + seed(i, 12) * 50;
    const trail = ctx.createLinearGradient(x, y, x - 3, y + length);
    trail.addColorStop(0, `${palette.accent}00`); trail.addColorStop(1, `${palette.accent}70`);
    ctx.strokeStyle = trail; ctx.globalAlpha = .25 + seed(i, 4) * .5; ctx.lineWidth = .6 + seed(i) * .6;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 3, y + length); ctx.stroke();
  }
  for (let i = 0; i < 28; i++) {
    const radius = 1.6 + seed(i, 7) * 3.3, speed = i % 4 === 0 ? 22 : 2;
    const x = seed(i, side + 27) * w, y = (seed(i, 23) * (h + 40) + t * speed) % (h + 40) - 20;
    ctx.globalAlpha = .65; ctx.fillStyle = `${palette.background}80`;
    ctx.beginPath(); ctx.ellipse(x, y, radius, radius * 1.5, .12, 0, TAU); ctx.fill();
    ctx.strokeStyle = `${palette.accent}75`; ctx.lineWidth = .7; ctx.stroke();
    ctx.strokeStyle = `${palette.text}b0`;
    ctx.beginPath(); ctx.ellipse(x - radius * .1, y - radius * .2, radius * .65, radius, .12, Math.PI, Math.PI * 1.6); ctx.stroke();
    if (speed > 2) {
      ctx.strokeStyle = `${palette.accent}25`; ctx.lineWidth = radius * .7;
      ctx.beginPath(); ctx.moveTo(x, y - radius); ctx.lineTo(x + 1, y - radius - 26); ctx.stroke();
    }
  }
}

/** Twinkling stars and periodic shooting trails stay entirely outside the room. */
function stars(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, palette: OfficeUiPalette, side: number) {
  for (let i = 0; i < 46; i++) {
    const x = seed(i, side + 31) * w, y = seed(i, 37) * h;
    const pulse = .22 + (Math.sin(t * (.6 + seed(i)) + i * 2) + 1) * .27;
    const radius = .6 + seed(i, 41) * 1.5;
    ctx.globalAlpha = pulse; ctx.fillStyle = i % 4 === 0 ? palette.accent : palette.text;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
    if (i % 7 === 0) {
      glow(ctx, x, y, radius * 6, radius * 6, palette.accent, pulse * .2);
      ctx.strokeStyle = palette.text; ctx.lineWidth = .6; ctx.globalAlpha = pulse * .5;
      ctx.beginPath(); ctx.moveTo(x - radius * 3, y); ctx.lineTo(x + radius * 3, y);
      ctx.moveTo(x, y - radius * 3); ctx.lineTo(x, y + radius * 3); ctx.stroke();
    }
  }
  for (let i = 0; i < 3; i++) {
    const phase = (t + seed(i, side + 43) * 12) % 12;
    if (phase > 2.4) continue;
    const progress = phase / 2.4, length = 45 + seed(i) * 60;
    const x = w * (.2 + seed(i, 47) * .55) - progress * w * .28;
    const y = h * (.12 + seed(i, 53) * .65) + progress * length * 1.8;
    const trail = ctx.createLinearGradient(x + length * .3, y - length, x, y);
    trail.addColorStop(0, `${palette.accent}00`); trail.addColorStop(1, palette.text);
    ctx.globalAlpha = Math.sin(progress * Math.PI) * .7; ctx.strokeStyle = trail; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x + length * .3, y - length); ctx.lineTo(x, y); ctx.stroke();
    glow(ctx, x, y, 5, 5, palette.text, Math.sin(progress * Math.PI) * .4);
  }
}

/** Gentle flakes with sparse crystalline highlights, using a fixed particle count. */
function snow(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, palette: OfficeUiPalette, side: number) {
  for (let i = 0; i < 40; i++) {
    const radius = .8 + seed(i, 59) * 2.5, speed = 10 + seed(i, 61) * 20;
    const x = seed(i, side + 67) * w + Math.sin(t * .22 + i * 1.7) * (5 + radius * 3);
    const y = (seed(i, 71) * (h + 30) + t * speed) % (h + 30) - 15;
    ctx.globalAlpha = .3 + seed(i, 73) * .5; ctx.fillStyle = palette.text;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
    if (i % 8 === 0) {
      glow(ctx, x, y, radius * 4, radius * 4, palette.accent, .12);
      ctx.strokeStyle = palette.text; ctx.lineWidth = .7; ctx.globalAlpha = .6;
      ctx.beginPath();
      for (let arm = 0; arm < 3; arm++) {
        const angle = arm * Math.PI / 3 + t * .08, dx = Math.cos(angle) * radius * 2.2, dy = Math.sin(angle) * radius * 2.2;
        ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy);
      }
      ctx.stroke();
    }
  }
}

/** Called by the room's existing 30 FPS clock; owns no RAF, timer, texture or network request. */
export class OfficeMarginEffects {
  private signature = '';
  private frames = 0;
  private visible = false;
  private bytes = 0;

  diagnostics() { return { marginEffectFrames: this.frames, marginEffectVisible: this.visible, marginEffectBytes: this.bytes }; }

  draw(canvases: readonly (HTMLCanvasElement | null)[], layout: OfficeMarginLayout, mode: OfficeMarginMode | null, time: number, palette: OfficeUiPalette): void {
    this.visible = !!mode && layout.width > 0;
    this.bytes = this.visible ? layout.pixelWidth * layout.pixelHeight * 8 : 0;
    const signature = this.visible ? JSON.stringify([mode, layout, time, palette.accent, palette.muted, palette.text, palette.background]) : 'hidden';
    if (signature === this.signature) return;
    this.signature = signature;
    canvases.forEach((canvas, side) => {
      if (!canvas) return;
      canvas.hidden = !this.visible;
      const width = this.visible ? layout.pixelWidth : 1, height = this.visible ? layout.pixelHeight : 1;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      if (!this.visible || !mode) return;
      canvas.style.width = `${layout.width}px`; canvas.style.height = `${layout.height}px`;
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.setTransform(width / layout.width, 0, 0, height / layout.height, 0, 0);
      ctx.clearRect(0, 0, layout.width, layout.height); ctx.save();
      if (mode === 'aurora') aurora(ctx, layout.width, layout.height, time / 1000, palette, side);
      else if (mode === 'matrix') matrix(ctx, layout.width, layout.height, time / 1000, palette, side);
      else if (mode === 'rain') rain(ctx, layout.width, layout.height, time / 1000, palette, side);
      else if (mode === 'stars') stars(ctx, layout.width, layout.height, time / 1000, palette, side);
      else if (mode === 'snow') snow(ctx, layout.width, layout.height, time / 1000, palette, side);
      else neon(ctx, layout.width, layout.height, time / 1000, palette, side);
      ctx.restore();
    });
    if (this.visible) this.frames++;
  }
}
