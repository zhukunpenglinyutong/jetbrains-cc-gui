import { OFFICE_FLOOR_CAPACITY, phaseColor } from './officeModel';
import type { OfficeSource } from './officeModel';
import { OFFICE_THEME_PALETTES } from './officeThemes';
import type { OfficeThemeId, OfficeThemePalette } from './officeThemes';
import { ILLUSTRATED_OFFICE_THEMES, paintIllustratedOffice, paintThemedDeskDetails } from './officeScenery';
import { OFFICE_ART_SEATS } from './officeArtGeometry';
import type { OfficeCamera } from './officeCamera';
import { drawOfficeAmbience, drawOfficeTaskFeedback } from './officeSceneEffects';
import type { OfficeScenePresentation } from './officeSceneEffects';
import type { OfficeActorMotion } from './officeTransitions';

export const OFFICE_SCENE_WIDTH = 1160;
export const OFFICE_SCENE_HEIGHT = 1040;

export interface OfficeHitRegion {
  sourceKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OfficePetVisual {
  width?: number;
  height?: number;
  frame: (source: OfficeSource, time: number) => CanvasImageSource | null;
  crop?: (source: OfficeSource, time: number) => { x: number; y: number; width: number; height: number };
  opacity?: number;
  builtinPhase?: OfficeSource['phase'];
  motion?: OfficeActorMotion;
}

export interface OfficeBackgroundVisual { image: CanvasImageSource; width: number; height: number }
const roomCache = new WeakMap<HTMLCanvasElement, { theme: OfficeThemeId; height: number; room: HTMLCanvasElement }>();
const COLUMNS = 4;
const ROWS = OFFICE_FLOOR_CAPACITY / COLUMNS;
const ROW_GAP = 280;
export function officeSceneHeight(sources: readonly OfficeSource[], artwork = false): number {
  if (artwork) return OFFICE_SCENE_HEIGHT;
  const rows = Math.max(2, ...sources.map(source => Math.floor(source.seat % OFFICE_FLOOR_CAPACITY / COLUMNS) + 1));
  return OFFICE_SCENE_HEIGHT - (ROWS - rows) * ROW_GAP;
}
function position(seat: number): { x: number; y: number } {
  const slot = seat % OFFICE_FLOOR_CAPACITY;
  return { x: 194 + (slot % COLUMNS) * 256, y: 280 + Math.floor(slot / COLUMNS) * ROW_GAP };
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: string, radius = 0): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function plant(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1): void {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  box(ctx, -13, 0, 26, 25, '#ba7f63', 5); box(ctx, -16, -3, 32, 7, '#d5a78d', 3);
  ctx.strokeStyle = '#487965'; ctx.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    const angle = (i - 2) * .38;
    ctx.save(); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -49); ctx.stroke();
    ctx.fillStyle = i % 2 ? '#79a389' : '#588e76'; ctx.beginPath(); ctx.ellipse(0, -35, 9, 23, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  ctx.restore();
}

function desk(ctx: CanvasRenderingContext2D, x: number, y: number, occupied: boolean, color: string, palette: OfficeThemePalette, drawChair = true, theme: OfficeThemeId = 'loft'): void {
  box(ctx, x - 83, y + 14, 181, 16, '#73554322', 8);
  if (drawChair) {
    box(ctx, x - 29, y - 48, 58, 73, palette.chair, 15);
    box(ctx, x - 23, y - 41, 46, 27, palette.chairLight, 9);
    box(ctx, x - 12, y + 23, 24, 7, '#495968', 3);
  }
  box(ctx, x - 77, y + 5, 7, 24, palette.deskLeg, 3); box(ctx, x + 77, y + 5, 7, 24, palette.deskLeg, 3);
  box(ctx, x - 86, y - 9, 178, 16, palette.deskEdge, 6);
  box(ctx, x - 86, y - 15, 178, 13, palette.deskTop, 6);
  if (occupied) box(ctx, x - 77, y - 11, 92, 2, palette.accent, 1);
  box(ctx, x + 48, y - 54, 42, 33, palette.monitor, 5);
  box(ctx, x + 52, y - 50, 34, 23, occupied ? color : palette.screen, 3);
  box(ctx, x + 67, y - 23, 5, 8, palette.monitor, 2); box(ctx, x + 58, y - 17, 24, 3, palette.monitor, 2);
  box(ctx, x + 45, y - 8, 36, 3, '#a29584', 1);
  box(ctx, x - 70, y - 24, 13, 11, '#f8f4e9', 3);
  ctx.strokeStyle = '#f8f4e9'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x - 55, y - 19, 4, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  paintThemedDeskDetails(ctx, theme, x, y, palette);
}

function windowView(ctx: CanvasRenderingContext2D, x: number, theme: OfficeThemeId, index: number, palette: OfficeThemePalette): void {
  box(ctx, x - 8, 41, 220, 120, palette.accent, theme === 'cultivation' ? 28 : 7);
  box(ctx, x - 3, 46, 210, 110, palette.monitor, theme === 'cultivation' ? 24 : 4);
  ctx.save(); ctx.beginPath(); ctx.roundRect(x + 2, 51, 200, 100, theme === 'cultivation' ? 22 : 2); ctx.clip();
  const sky = ctx.createLinearGradient(0, 51, 0, 151);
  const colors = theme === 'loft' ? ['#91afcf', '#f8dcb8'] : theme === 'cyberpunk' ? ['#0a152d', '#43335e'] : theme === 'cultivation' ? ['#a8d8d1', '#e9f5de'] : ['#061023', '#193455'];
  sky.addColorStop(0, colors[0]); sky.addColorStop(1, colors[1]); ctx.fillStyle = sky; ctx.fillRect(x + 2, 51, 200, 100);
  if (theme === 'loft' || theme === 'cyberpunk') {
    if (theme === 'loft') { ctx.fillStyle = '#efc997'; ctx.beginPath(); ctx.arc(x + 156, 83, 17, 0, Math.PI * 2); ctx.fill(); }
    for (let i = 0; i < 9; i++) {
      const h = theme === 'loft' ? 12 + (i * 13 + index * 7) % 27 : 22 + (i * 17 + index * 11) % 62;
      box(ctx, x + 2 + i * 23, 151 - h, 19, h, theme === 'loft' ? '#7e97ad80' : '#131b34');
      if (theme === 'cyberpunk') for (let y = 157 - h; y < 146; y += 10) box(ctx, x + 6 + i * 23, y, 10, 2, i % 2 ? '#ec7cd4' : '#62dce7');
    }
    if (theme === 'cyberpunk') { box(ctx, x + 12, 128, 50, 5, '#ed77d7', 2); box(ctx, x + 119, 99, 52, 4, '#75e8ec', 2); }
  } else if (theme === 'cultivation') {
    ctx.fillStyle = '#f9f1cf'; ctx.beginPath(); ctx.arc(x + 159, 79, 14, 0, Math.PI * 2); ctx.fill();
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = ['#93bcb4', '#729f98', '#537f7b'][layer]; ctx.beginPath(); ctx.moveTo(x + 2, 151);
      for (let i = 0; i <= 8; i++) ctx.lineTo(x + 2 + i * 26, 99 + layer * 14 - ((i * 7 + layer * 11 + index * 3) % 25));
      ctx.lineTo(x + 202, 151); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f3fae973'; ctx.beginPath(); ctx.ellipse(x + 67 + layer * 32, 116 + layer * 10, 75, 6, 0, 0, Math.PI * 2); ctx.fill();
    }
    box(ctx, x + 139, 106, 15, 17, '#6d785d'); ctx.fillStyle = '#576952'; ctx.beginPath(); ctx.moveTo(x + 133, 109); ctx.lineTo(x + 147, 98); ctx.lineTo(x + 161, 109); ctx.fill();
  } else {
    for (let i = 0; i < 26; i++) { ctx.fillStyle = i % 3 ? '#c6e7f0' : '#6aafd0'; ctx.beginPath(); ctx.arc(x + 9 + (i * 43 + index * 17) % 188, 56 + (i * 29) % 87, i % 3 ? .8 : 1.5, 0, Math.PI * 2); ctx.fill(); }
    if (index === 1) {
      ctx.fillStyle = '#85b7d5'; ctx.beginPath(); ctx.arc(x + 109, 99, 31, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#b5d9e2'; ctx.lineWidth = 4; ctx.beginPath(); ctx.ellipse(x + 109, 99, 53, 10, -.25, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#35668c80'; ctx.beginPath(); ctx.arc(x + 119, 95, 26, 0, Math.PI * 2); ctx.fill();
    } else { ctx.strokeStyle = '#5d9ab466'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 34, 77); ctx.lineTo(x + 91, 108); ctx.lineTo(x + 161, 69); ctx.stroke(); }
  }
  ctx.restore();
  if (theme === 'loft') { box(ctx, x + 99, 49, 4, 104, '#486078'); box(ctx, x, 105, 205, 3, '#486078'); }
  box(ctx, x - 15, 157, 234, 7, palette.accent, 3);
}

function cornerDecor(ctx: CanvasRenderingContext2D, x: number, y: number, theme: OfficeThemeId, scale: number): void {
  if (theme === 'loft') { plant(ctx, x, y, scale); return; }
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  if (theme === 'cyberpunk') {
    box(ctx, -15, -63, 30, 85, '#242f49', 7); box(ctx, -18, 16, 36, 7, '#563f71', 3);
    for (let row = 0; row < 6; row++) { box(ctx, -10, -53 + row * 11, 20, 4, row % 2 ? '#cf6dbd' : '#6bd0de', 1); }
  } else if (theme === 'cultivation') {
    box(ctx, -3, -83, 6, 105, '#6b6650', 2); box(ctx, -19, -90, 38, 7, '#7f694d', 3);
    box(ctx, -15, -69, 30, 37, '#e3b777', 9); box(ctx, -17, -72, 34, 5, '#887052', 2);
    box(ctx, -1, -32, 2, 18, '#a07046'); box(ctx, -18, 18, 36, 7, '#6b6650', 3);
  } else {
    box(ctx, -16, -55, 32, 78, '#354f67', 8); box(ctx, -12, -47, 24, 40, '#6bc8df', 4);
    for (let row = 0; row < 3; row++) box(ctx, -8, -36 + row * 9, 16, 2, '#d4f5ff', 1);
    box(ctx, -19, 17, 38, 6, '#87a9bd', 3);
  }
  ctx.restore();
}

/** Retain one cached room per canvas, including theme changes; actors draw independently. */
function defaultRoom(canvas: HTMLCanvasElement, theme: OfficeThemeId, height: number): HTMLCanvasElement {
  const cached = roomCache.get(canvas); if (cached?.theme === theme && cached.height === height) return cached.room;
  if (cached) { cached.room.width = 0; cached.room.height = 0; }
  const palette = OFFICE_THEME_PALETTES[theme];
  const room = document.createElement('canvas'); room.width = OFFICE_SCENE_WIDTH; room.height = height;
  const ctx = room.getContext('2d')!;
  box(ctx, 0, 0, OFFICE_SCENE_WIDTH, height, '#171f27');
  ctx.save(); ctx.beginPath(); ctx.roundRect(24, 20, 1112, height - 40, 20); ctx.clip();
  const wall = ctx.createLinearGradient(0, 20, 0, 205); wall.addColorStop(0, palette.wall[0]); wall.addColorStop(1, palette.wall[1]);
  ctx.fillStyle = wall; ctx.fillRect(24, 20, 1112, 190);
  const floor = ctx.createLinearGradient(0, 200, 0, height - 20); floor.addColorStop(0, palette.floor[0]); floor.addColorStop(1, palette.floor[1]);
  ctx.fillStyle = floor; ctx.fillRect(24, 200, 1112, height - 220);
  const tileHeight = theme === 'loft' ? 35 : 70;
  for (let y = 200, row = 0; y < height - 20; y += tileHeight, row++) {
    box(ctx, 24, y, 1112, 1, palette.grid);
    for (let col = 0; col < 7; col++) box(ctx, 30 + col * 190 + row % 2 * 95, y, 1, tileHeight, palette.grid);
  }
  box(ctx, 24, 194, 1112, 9, palette.accent); box(ctx, 24, 190, 1112, 4, palette.deskTop);
  if (ILLUSTRATED_OFFICE_THEMES.includes(theme)) {
    paintIllustratedOffice(ctx, theme, height);
  } else {
  for (let index = 0; index < 4; index++) {
    const x = 94 + index * 252;
    windowView(ctx, x, theme, index, palette);
    if (theme === 'loft') { ctx.fillStyle = '#fff1ca1c'; ctx.beginPath(); ctx.moveTo(x + 3, 204); ctx.lineTo(x + 190, 204); ctx.lineTo(x + 270, 420); ctx.lineTo(x + 32, 420); ctx.fill(); }
  }
  box(ctx, 548, 224, 64, height - 271, theme === 'loft' ? '#617d8024' : `${palette.accent}18`, 14);
  if (theme === 'cultivation') {
    ctx.strokeStyle = '#7c987278'; ctx.lineWidth = 2;
    for (let y = 350; y < height - 60; y += 216) { ctx.beginPath(); ctx.arc(580, y, 23, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(580, y - 17); ctx.lineTo(594, y); ctx.lineTo(580, y + 17); ctx.lineTo(566, y); ctx.closePath(); ctx.stroke(); }
  } else for (let y = 237; y < height - 47; y += theme === 'loft' ? 15 : 32) box(ctx, 559, y, 42, theme === 'loft' ? 1 : 3, theme === 'loft' ? '#e9e0c61c' : `${palette.accent}88`, 1);
  for (const x of [56, 1105]) { cornerDecor(ctx, x, 192, theme, 1.2); cornerDecor(ctx, x, height - 83, theme, .85); }
  }
  const seats = (ROWS - (OFFICE_SCENE_HEIGHT - height) / ROW_GAP) * COLUMNS;
  for (let seat = 0; seat < seats; seat++) { const p = position(seat); desk(ctx, p.x, p.y, false, palette.screen, palette, true, theme); }
  ctx.restore();
  roomCache.set(canvas, { theme, height, room }); return room;
}

/** Port of the current Java Pet's built-in robot; no reference-project art. */
export function paintOfficeRobot(ctx: CanvasRenderingContext2D, x: number, y: number, phase: OfficeSource['phase'], time: number, seed: number): void {
  const working = phase === 'RUNNING' || phase === 'THINKING';
  const bob = working ? Math.sin(time / 260 + seed) * 2 : 0;
  const blink = (time + seed * 113) % 4700 > 4500;
  ctx.save();
  ctx.translate(x, y + bob);
  box(ctx, -18, -39, 36, 33, '#323741', 6);
  box(ctx, -11, -31, 7, blink ? 2 : 7, '#73cbff', 1);
  box(ctx, 4, -31, 7, blink ? 2 : 7, '#73cbff', 1);
  box(ctx, -8, -16, 16, 2, '#73cbff');
  box(ctx, -1, -47, 2, 8, '#323741');
  ctx.fillStyle = phaseColor(phase);
  ctx.beginPath(); ctx.arc(0, -50, 4, 0, Math.PI * 2); ctx.fill();
  box(ctx, -14, -5, 9, 10, '#252c34', 2);
  box(ctx, 5, -5, 9, 10, '#252c34', 2);
  if (phase === 'WAITING_USER') {
    ctx.fillStyle = '#e8b866';
    ctx.beginPath(); ctx.arc(24, -46, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#242b31'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('?', 24, -42);
  }
  ctx.restore();
}

/** SVG environment and foreground remain vectors; the transparent canvas only animates pets and labels. */
function drawVectorActors(ctx: CanvasRenderingContext2D, sources: readonly OfficeSource[], selected: string | null, time: number,
  theme: OfficeThemeId, visual?: OfficePetVisual | ((source: OfficeSource) => OfficePetVisual | undefined), presentation?: OfficeScenePresentation): OfficeHitRegion[] {
  const regions: OfficeHitRegion[] = [];
  for (const source of [...sources].sort((a, b) => a.seat - b.seat)) {
    const seat = OFFICE_ART_SEATS[theme][source.seat % OFFICE_FLOOR_CAPACITY];
    const { scale, half, x, y, label } = seat;
    const previous = OFFICE_ART_SEATS[theme][source.seat % OFFICE_FLOOR_CAPACITY - 4];
    const previousLabel = previous?.label ?? 0;
    const actorHeight = Math.min(144 * scale, previous ? y - previousLabel - 30 : 144 * scale);
    const regionTop = Math.max(y - 165 * scale, previous ? previousLabel + 23 : 0);
    const region = { sourceKey: source.sourceKey, x: x - half, y: regionTop, width: half * 2, height: label + 22 - regionTop };
    const actor = typeof visual === 'function' ? visual(source) : visual;
    const motion = actor?.motion;
    if (source.sourceKey === selected && !motion?.exiting) {
      box(ctx, region.x, region.y, region.width, region.height, `${presentation?.palette.accent ?? '#b7dfd8'}22`, 8);
      ctx.strokeStyle = presentation?.palette.accent ?? '#c1ebd8'; ctx.lineWidth = 2; ctx.strokeRect(region.x, region.y, region.width, region.height);
    }
    ctx.save(); ctx.globalAlpha = motion?.alpha ?? 1; ctx.fillStyle = '#101b1b30'; ctx.beginPath(); ctx.ellipse(x, y - 3 * scale, 44 * scale, 7 * scale, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    const image = actor?.frame(source, time), crop = actor?.crop?.(source, time);
    ctx.save(); ctx.globalAlpha = (actor?.opacity ?? 1) * (motion?.alpha ?? 1); ctx.translate(0, (motion?.lift ?? 0) * scale);
    if (image) {
      const width = crop?.width ?? actor?.width ?? 100, height = crop?.height ?? actor?.height ?? 108;
      const ratio = Math.min(128 * scale / width, actorHeight / height);
      const w = width * ratio, h = height * ratio;
      if (crop) ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, x - w / 2, y - h, w, h);
      else ctx.drawImage(image, x - w / 2, y - h, w, h);
    } else {
      ctx.translate(x, y - 8 * scale); const robotScale = Math.min(2.3 * scale, actorHeight / 60); ctx.scale(robotScale, robotScale);
      paintOfficeRobot(ctx, 0, 0, actor?.builtinPhase ?? source.phase, time, source.seat);
    }
    ctx.restore();
    if (motion?.exiting) continue;
    const width = 176 * scale;
    box(ctx, x - width / 2, label - 5, width, 27, source.sourceKey === selected ? `${presentation?.palette.selected ?? '#284b40'}f0` : `${presentation?.palette.panel ?? '#15252c'}f0`, 5);
    ctx.textAlign = 'center'; ctx.fillStyle = '#eff8f3'; ctx.font = `600 ${11 * scale}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    const fit = (value: string) => {
      let text = value;
      while (ctx.measureText(text).width > width - 24 * scale && text.length > 2) text = text.slice(0, -2) + '…';
      return text;
    };
    ctx.fillText(fit(source.projectLabel), x, label + 6);
    ctx.fillStyle = '#bdd2d6'; ctx.font = `${9 * scale}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.fillText(fit(`${source.tabLabel} · ${source.product}`), x, label + 17);
    ctx.fillStyle = phaseColor(source.phase); ctx.beginPath(); ctx.arc(x + width / 2 - 7 * scale, label + 8.5, 2.5 * scale, 0, Math.PI * 2); ctx.fill();
    if (presentation) drawOfficeTaskFeedback(ctx, source.sourceKey, x, y, scale, presentation.effectTime, presentation);
    regions.push(region);
  }
  return regions;
}

export function drawOfficeScene(
  canvas: HTMLCanvasElement,
  sources: readonly OfficeSource[],
  selected: string | null,
  time: number,
  visual?: OfficePetVisual | ((source: OfficeSource) => OfficePetVisual | undefined),
  background?: OfficeBackgroundVisual,
  theme: OfficeThemeId = 'loft',
  height: number = OFFICE_SCENE_HEIGHT,
  camera?: OfficeCamera,
  vectorTheme?: OfficeThemeId,
  presentation?: OfficeScenePresentation,
): OfficeHitRegion[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const view = camera ?? { x: 0, y: 0, width: OFFICE_SCENE_WIDTH, height };
  const sx = canvas.width / view.width, sy = canvas.height / view.height;
  ctx.setTransform(sx, 0, 0, sy, -view.x * sx, -view.y * sy);
  ctx.clearRect(view.x, view.y, view.width, view.height);
  if (vectorTheme) {
    if (presentation?.ambience) drawOfficeAmbience(ctx, vectorTheme, time);
    return drawVectorActors(ctx, sources, selected, time, vectorTheme, visual, presentation);
  }
  if (background) {
    box(ctx, 0, 0, OFFICE_SCENE_WIDTH, height, '#1e293d'); ctx.save(); ctx.beginPath(); ctx.roundRect(24, 20, 1112, height - 40, 20); ctx.clip();
    const scale = Math.max(1112 / background.width, (height - 40) / background.height);
    const width = background.width * scale, imageHeight = background.height * scale;
    ctx.drawImage(background.image, 24 + (1112 - width) / 2, 20 + (height - 40 - imageHeight) / 2, width, imageHeight); ctx.restore();
  } else ctx.drawImage(defaultRoom(canvas, theme, height), 0, 0);
  const palette = OFFICE_THEME_PALETTES[theme];
  const regions: OfficeHitRegion[] = [];
  for (const source of sources) {
    const { x, y } = position(source.seat);
    const actorVisual = typeof visual === 'function' ? visual(source) : visual;
    const selectedSource = source.sourceKey === selected && !actorVisual?.motion?.exiting;
    if (selectedSource) { box(ctx, x - 108, y - 142, 216, 208, '#657eaa30', 16); ctx.strokeStyle = theme === 'loft' ? '#5a75b4' : palette.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(x - 108, y - 142, 216, 208, 16); ctx.stroke(); }
    if (!actorVisual?.motion?.exiting) box(ctx, x - 29, y - 48, 58, 73, palette.chair, 15);
    ctx.save();
    ctx.globalAlpha = (actorVisual?.opacity ?? 1) * (actorVisual?.motion?.alpha ?? 1); ctx.translate(0, actorVisual?.motion?.lift ?? 0);
    const image = actorVisual?.frame(source, time);
    if (image) {
      const crop = actorVisual?.crop?.(source, time);
      if (crop) ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, x - 50, y - 123, 100, 108);
      else {
        const scale = Math.min(100 / (actorVisual?.width ?? 50), 108 / (actorVisual?.height ?? 54));
        const width = (actorVisual?.width ?? 50) * scale;
        const height = (actorVisual?.height ?? 54) * scale;
        ctx.drawImage(image, x - width / 2, y - 15 - height, width, height);
      }
    } else { ctx.translate(x, y - 24); ctx.scale(1.9, 1.9); paintOfficeRobot(ctx, 0, 0, actorVisual?.builtinPhase ?? source.phase, time, source.seat); }
    ctx.restore();
    if (actorVisual?.motion?.exiting) continue;
    desk(ctx, x, y, true, phaseColor(source.phase), palette, false, theme);
    box(ctx, x - 103, y + 33, 206, 32, palette.label, 7);
    ctx.fillStyle = palette.text; ctx.font = '600 13px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    let label = source.projectLabel; while (ctx.measureText(label).width > 188 && label.length > 2) label = label.slice(0, -2) + '…';
    ctx.fillText(label, x, y + 46);
    ctx.font = '11px "Segoe UI", sans-serif';
    label = `${source.tabLabel} · ${source.product}`; while (ctx.measureText(label).width > 188 && label.length > 2) label = label.slice(0, -2) + '…';
    ctx.fillText(label, x, y + 60);
    ctx.fillStyle = phaseColor(source.phase); ctx.beginPath(); ctx.arc(x - 92, y - 107, 5, 0, Math.PI * 2); ctx.fill();
    regions.push({ sourceKey: source.sourceKey, x: x - 108, y: y - 142, width: 216, height: 208 });
    if (presentation) drawOfficeTaskFeedback(ctx, source.sourceKey, x, y - 15, 1, presentation.effectTime, presentation);
  }
  return regions;
}

export function hitTestOffice(regions: readonly OfficeHitRegion[], x: number, y: number): string | null {
  return regions.find(region => x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height)?.sourceKey ?? null;
}
