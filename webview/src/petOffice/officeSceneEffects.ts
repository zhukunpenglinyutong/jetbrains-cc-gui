import type { OfficeTaskEffect } from './officeFeedback';
import type { OfficeThemeId } from './officeThemes';
import type { OfficeUiPalette } from './officePresentation';

export interface OfficeScenePresentation {
  palette: OfficeUiPalette; ambience: boolean; effectTime: number;
  effects: readonly OfficeTaskEffect[]; attention: ReadonlySet<string>;
}

const COLORS: Record<OfficeThemeId, string> = { loft: '#ffdf9a', cyberpunk: '#81ecff', cultivation: '#f5edce', space: '#c8e8ff',
  forest: '#d8eda0', library: '#e8c391', ocean: '#9ce8e9', zen: '#f5dfde', retro: '#f1c78f' };
const TAU = Math.PI * 2;

/** Eighteen deterministic motes at most, spread through the room. The scene owns the only animation clock. */
export function drawOfficeAmbience(ctx: CanvasRenderingContext2D, theme: OfficeThemeId, time: number): void {
  ctx.save();
  const t = time / 1000;
  ctx.fillStyle = COLORS[theme]; ctx.strokeStyle = COLORS[theme];
  const daylight = theme === 'loft' || theme === 'forest' || theme === 'zen' || theme === 'cultivation' || theme === 'library';
  if (daylight) {
    ctx.globalAlpha = .045 + Math.sin(t / 7) * .012;
    const drift = Math.sin(t / 9) * 15;
    const beam = ctx.createLinearGradient(770, 120, 420, 920);
    beam.addColorStop(0, `${COLORS[theme]}00`); beam.addColorStop(.25, COLORS[theme]); beam.addColorStop(1, `${COLORS[theme]}00`);
    ctx.fillStyle = beam;
    ctx.beginPath(); ctx.moveTo(735 + drift, 50); ctx.lineTo(855 + drift, 50); ctx.lineTo(620 + drift, 990); ctx.lineTo(315 + drift, 990); ctx.closePath(); ctx.fill();
    ctx.fillStyle = COLORS[theme];
  }
  for (let index = 0; index < 18; index++) {
    const near = index % 3 / 2;
    const cycle = (t / (theme === 'ocean' ? 24 : 42) + index * .618) % 1;
    const x = 70 + (index * 137 % 1020) + Math.sin(t / (5 + near * 3) + index * 2) * (8 + near * 12);
    const y = theme === 'ocean' ? 980 - cycle * 940 : 50 + cycle * 890;
    ctx.globalAlpha = (.14 + near * .15) * Math.sin(cycle * Math.PI);
    ctx.lineWidth = .8 + near * .4; ctx.beginPath();
    if (theme === 'ocean') { ctx.arc(x, y, 2 + near * 3, 0, TAU); ctx.stroke(); }
    else if (theme === 'cyberpunk' || theme === 'retro') {
      ctx.moveTo(x, y - 5 - near * 5); ctx.lineTo(x, y); ctx.stroke(); ctx.fillRect(x - 1, y, 2, 2);
    } else if (theme === 'forest' || theme === 'zen') {
      ctx.ellipse(x, y, 3 + near * 2, 1.4 + near, t / 6 + index, 0, TAU); ctx.fill();
    } else if (theme === 'space' || theme === 'library' || theme === 'cultivation') {
      const radius = 2 + near * 2;
      ctx.moveTo(x - radius, y); ctx.quadraticCurveTo(x, y, x, y - radius);
      ctx.quadraticCurveTo(x, y, x + radius, y); ctx.quadraticCurveTo(x, y, x, y + radius); ctx.quadraticCurveTo(x, y, x - radius, y); ctx.fill();
    } else { ctx.arc(x, y, .9 + near, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

/** Staged bloom, elliptical shockwaves and tapered sparks accompany the Motion chip above the foreground. */
export function drawOfficeTaskFeedback(ctx: CanvasRenderingContext2D, sourceKey: string, x: number, y: number, scale: number,
  time: number, presentation: OfficeScenePresentation): void {
  const effect = presentation.effects.find(effect => effect.sourceKey === sourceKey);
  const waiting = presentation.attention.has(sourceKey);
  if (!effect && !waiting) return;
  const progress = effect ? Math.min(1, Math.max(0, (time - effect.startedAt) / (effect.expiresAt - effect.startedAt))) : 1;
  const outcome = effect?.outcome ?? 'WAITING_USER';
  const color = outcome === 'SUCCEEDED' ? '#8aefc5' : outcome === 'FAILED' ? '#ffad9c' : outcome === 'WAITING_USER' ? '#ffe0a3' : '#d7cdeb';
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (effect) {
    const enter = 1 - (1 - Math.min(1, progress / .16)) ** 3;
    const fade = Math.min(1, (1 - progress) / .28);
    const bloom = ctx.createRadialGradient(0, -73, 8, 0, -73, 108);
    bloom.addColorStop(0, `${color}55`); bloom.addColorStop(.5, `${color}20`); bloom.addColorStop(1, `${color}00`);
    ctx.globalAlpha = enter * fade; ctx.fillStyle = bloom; ctx.fillRect(-110, -183, 220, 220); ctx.fillStyle = color;
    for (let wave = 0; wave < 2; wave++) {
      const p = Math.max(0, Math.min(1, (progress - wave * .12) / .65));
      ctx.globalAlpha = (1 - p) * enter * fade * .6; ctx.lineWidth = 2 - p;
      ctx.beginPath(); ctx.ellipse(0, -3, 36 + p * 69, 7 + p * 13, 0, 0, TAU); ctx.stroke();
    }
    const success = outcome === 'SUCCEEDED';
    const count = success ? 12 : 6;
    for (let index = 0; index < count; index++) {
      const angle = index * TAU / count - Math.PI / 2;
      const spread = 22 + (1 - (1 - progress) ** 3) * (success ? 82 : 48);
      const px = Math.cos(angle) * spread, py = -76 + Math.sin(angle) * spread * .65 - progress * 24;
      const radius = (index % 3 === 0 ? 5 : 2.4) * enter;
      ctx.globalAlpha = fade * (1 - progress * .65); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(px - Math.cos(angle) * 8 * (1 - progress), py - Math.sin(angle) * 6 * (1 - progress)); ctx.lineTo(px, py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, py - radius); ctx.quadraticCurveTo(px, py, px + radius, py);
      ctx.quadraticCurveTo(px, py, px, py + radius); ctx.quadraticCurveTo(px, py, px - radius, py); ctx.quadraticCurveTo(px, py, px, py - radius); ctx.fill();
    }
  }
  if (waiting) {
    // Leave a steady speech marker after the finite attention animation rather than an endless pulse.
    ctx.globalAlpha = .95; ctx.fillStyle = '#252b32ee'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.roundRect(47, -130, 27, 20, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(52, -110); ctx.lineTo(50, -105); ctx.lineTo(59, -110); ctx.stroke();
    ctx.fillStyle = color;
    for (let index = 0; index < 3; index++) { ctx.beginPath(); ctx.arc(54 + index * 6, -120, 1.2, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}
