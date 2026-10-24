import type { OfficeThemeId, OfficeThemePalette } from './officeThemes';

type Painter = CanvasRenderingContext2D;
export const ILLUSTRATED_OFFICE_THEMES: readonly OfficeThemeId[] = ['forest', 'library', 'ocean', 'zen', 'retro'];

function rect(c: Painter, x: number, y: number, w: number, h: number, color: string, r = 0): void {
  c.fillStyle = color; c.beginPath(); c.roundRect(x, y, w, h, r); c.fill();
}
function ellipse(c: Painter, x: number, y: number, rx: number, ry: number, color: string, rotation = 0): void {
  c.fillStyle = color; c.beginPath(); c.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2); c.fill();
}
function path(c: Painter, points: readonly number[], color: string): void {
  c.fillStyle = color; c.beginPath(); c.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1]);
  c.closePath(); c.fill();
}
function gradient(c: Painter, y1: number, y2: number, colors: readonly string[]): CanvasGradient {
  const fill = c.createLinearGradient(0, y1, 0, y2);
  colors.forEach((color, i) => fill.addColorStop(i / (colors.length - 1), color)); return fill;
}
function branch(c: Painter, x: number, y: number, scale: number, color: string): void {
  c.save(); c.translate(x, y); c.scale(scale, scale);
  c.strokeStyle = '#55785d'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, 20); c.lineTo(0, -38); c.stroke();
  for (let i = 0; i < 4; i++) {
    ellipse(c, -9, -25 + i * 12, 12, 5, color, .5); ellipse(c, 9, -30 + i * 12, 12, 5, color, -.5);
  }
  c.restore();
}
function shelf(c: Painter, x: number, y: number, w: number, rows: number, wood: string): void {
  rect(c, x, y, w, rows * 37 + 14, wood, 6); rect(c, x + 7, y + 7, w - 14, rows * 37, '#1f253580', 3);
  const colors = ['#929f84', '#b48b68', '#748c98', '#a78187', '#cab793', '#787393'];
  for (let row = 0; row < rows; row++) {
    for (let book = 0; book < Math.floor((w - 20) / 15); book++) {
      const h = 17 + (book * 7 + row * 11) % 12;
      rect(c, x + 12 + book * 15, y + 11 + row * 37 + 29 - h, 10 + book % 3, h, colors[(book + row * 3) % colors.length], 1);
      rect(c, x + 14 + book * 15, y + 13 + row * 37 + 29 - h, 7, 1, '#efe3bf66');
    }
    rect(c, x + 5, y + 40 + row * 37, w - 10, 4, '#c3a27580', 2);
  }
}
function forest(c: Painter, h: number): void {
  c.fillStyle = gradient(c, 20, 200, ['#f1ebcc', '#bfd3ac', '#87aa86']); c.fillRect(24, 20, 1112, 190);
  for (let i = 0; i < 14; i++) {
    const x = 30 + i * 86;
    rect(c, x + 21, 34 + i % 3 * 12, 10, 143, '#57765b50', 5);
    ellipse(c, x + 27, 43 + i % 3 * 12, 66, 42, i % 2 ? '#89b38b80' : '#a8c39a90');
    ellipse(c, x + 38, 114, 35, 23, '#60876950');
  }
  for (const x of [112, 424, 736, 1048]) {
    rect(c, x, 20, 10, 180, '#826d48'); rect(c, x + 2, 22, 3, 170, '#b69a6b');
    path(c, [x + 12, 50, x + 130, 50, x + 220, 435, x + 50, 435], '#fff1b01c');
  }
  rect(c, 24, 178, 1112, 22, '#7e6849'); rect(c, 24, 178, 1112, 5, '#e4ce9d');
  for (let i = 0; i < 36; i++) ellipse(c, 40 + i * 32, 31 + i % 4 * 4, 30, 14, i % 2 ? '#527e59' : '#759965', (i % 3 - 1) * .3);
  for (const x of [52, 1107]) {
    rect(c, x - 18, 211, 36, 36, '#978465', 7); rect(c, x - 22, 204, 44, 11, '#c5b38c', 4);
    branch(c, x, 172, 1.45, '#527d54'); branch(c, x + 12, 182, .9, '#7c9a65');
    branch(c, x, h - 61, 1.05, '#607f55');
  }
  for (let y = 310; y < h - 55; y += 216) {
    ellipse(c, 580, y + 15, 32, 18, '#ebdabc55'); ellipse(c, 580, y + 14, 23, 12, '#cdbb9955');
  }
}
function library(c: Painter, h: number): void {
  for (const x of [67, 328, 752, 1013]) shelf(c, x, 50, x === 1013 ? 86 : 185, 3, '#725542');
  rect(c, 531, 32, 96, 149, '#b18e63', 45); rect(c, 538, 39, 82, 135, '#3c4967', 39);
  c.save(); c.beginPath(); c.roundRect(541, 43, 76, 127, 35); c.clip();
  path(c, [580, 41, 616, 75, 580, 117, 542, 74], '#c2af9c');
  path(c, [580, 115, 616, 150, 580, 175, 542, 150], '#7fa9af');
  path(c, [542, 78, 578, 118, 542, 150], '#9d809e'); path(c, [618, 78, 582, 118, 618, 150], '#ac976d');
  c.restore(); rect(c, 577, 42, 4, 126, '#bc9566'); rect(c, 540, 114, 77, 4, '#bc9566');
  for (const x of [272, 885]) {
    rect(c, x - 2, 20, 4, 52, '#b39c7c'); ellipse(c, x, 91, 20, 24, '#e3bf7966');
    path(c, [x, 66, x + 15, 91, x, 114, x - 15, 91], '#efdba9'); ellipse(c, x, 126, 50, 6, '#f6e0ac10');
  }
  rect(c, 25, 190, 1110, 10, '#b18e65'); rect(c, 554, 228, 52, h - 278, '#442e47', 20);
  c.strokeStyle = '#c2a37755'; c.lineWidth = 1.5;
  for (let y = 305; y < h - 70; y += 216) {
    c.beginPath(); c.arc(580, y, 21, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(580, y - 16); c.lineTo(596, y + 10); c.lineTo(564, y + 10); c.closePath(); c.stroke();
  }
  for (const x of [54, 1110]) { rect(c, x - 10, h - 129, 20, 50, '#997853', 3); ellipse(c, x, h - 137, 23, 8, '#dec286'); }
}
function fish(c: Painter, x: number, y: number, s: number, color: string): void {
  ellipse(c, x, y, 13 * s, 5 * s, color); path(c, [x - 11 * s, y, x - 22 * s, y - 7 * s, x - 22 * s, y + 7 * s], color);
}
function ocean(c: Painter, h: number): void {
  rect(c, 63, 40, 1034, 145, '#739894', 22); rect(c, 70, 47, 1020, 131, '#133c53', 18);
  c.save(); c.beginPath(); c.roundRect(77, 54, 1006, 117, 14); c.clip();
  c.fillStyle = gradient(c, 54, 180, ['#77c9c2', '#347e91', '#143b59']); c.fillRect(77, 54, 1006, 117);
  for (let i = 0; i < 8; i++) path(c, [190 + i * 130, 50, 215 + i * 130, 50, 400 + i * 130, 185, 311 + i * 130, 185], '#c6fff314');
  for (let i = 0; i < 18; i++) fish(c, 140 + (i * 163) % 880, 77 + (i * 29) % 53, .3 + i % 3 * .2, '#c5e4cf88');
  fish(c, 815, 116, 2.1, '#153f5866'); fish(c, 375, 90, 1.5, '#2c687b88');
  for (let i = 0; i < 21; i++) {
    ellipse(c, 90 + i * 48, 174, 41, 16 + i % 3 * 5, '#1d5969');
    c.strokeStyle = i % 2 ? '#93c5b069' : '#bd989779'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(90 + i * 48, 178); c.bezierCurveTo(74 + i * 48, 150, 103 + i * 48, 149, 84 + i * 48, 134); c.stroke();
  }
  c.restore();
  for (const x of [320, 575, 830]) { rect(c, x, 47, 9, 131, '#739894'); rect(c, x + 2, 51, 2, 124, '#c9e4d355'); }
  rect(c, 61, 187, 1038, 7, '#72c3bd', 3);
  for (const x of [52, 1108]) {
    rect(c, x - 14, 223, 28, 90, '#17394a', 8); rect(c, x - 10, 232, 20, 37, '#6fc7c3', 4);
    for (let i = 0; i < 3; i++) rect(c, x - 7, 279 + i * 8, 14, 2, '#729c9e');
  }
  for (let y = 262; y < h - 60; y += 54) { rect(c, 562, y, 36, 2, '#76d3c577', 1); }
}
function zen(c: Painter, h: number): void {
  rect(c, 70, 45, 1020, 134, '#b4ab87', 5); rect(c, 76, 51, 1008, 122, '#e7e3c9');
  for (let x = 86; x < 1080; x += 42) rect(c, x, 51, 2, 122, '#a2a08280');
  for (let y = 69; y < 171; y += 26) rect(c, 76, y, 1008, 2, '#a2a08260');
  ellipse(c, 580, 108, 128, 88, '#776f50');
  c.save(); c.beginPath(); c.ellipse(580, 108, 119, 80, 0, 0, Math.PI * 2); c.clip();
  c.fillStyle = gradient(c, 25, 190, ['#dce6d0', '#a8c5ac']); c.fillRect(452, 20, 256, 170);
  ellipse(c, 625, 68, 16, 16, '#f4edcc');
  path(c, [450, 190, 450, 128, 500, 85, 564, 139, 608, 104, 710, 165, 710, 190], '#8ca58c');
  path(c, [450, 190, 450, 166, 506, 128, 558, 162, 647, 118, 710, 172, 710, 190], '#617f6c');
  c.restore();
  for (const x of [92, 1073]) {
    for (let i = 0; i < 3; i++) { rect(c, x + i * 8, 80 + i * 4, 4, 102, '#647c56', 2); for (let y = 90; y < 176; y += 20) rect(c, x + i * 8, y, 4, 2, '#a1b587'); }
    branch(c, x + 9, 105, .65, '#7f9765'); branch(c, x + 9, 137, .7, '#66825b');
  }
  rect(c, 25, 189, 1110, 11, '#b3ac8b'); rect(c, 550, 235, 60, h - 280, '#789a9266', 28);
  for (let y = 280, i = 0; y < h - 56; y += 78, i++) {
    ellipse(c, 580 + (i % 2 ? 5 : -5), y, 23, 12, '#e4e1c8'); ellipse(c, 577 + (i % 2 ? 5 : -5), y - 2, 15, 6, '#ffffff30');
  }
  for (const x of [54, 1108]) {
    ellipse(c, x, h - 59, 23, 9, '#6b7960'); ellipse(c, x + 3, h - 69, 17, 8, '#8c9678'); branch(c, x, h - 90, .7, '#617a55');
  }
}
function arcade(c: Painter, x: number, y: number): void {
  path(c, [x - 22, y + 14, x - 22, y - 59, x - 14, y - 86, x + 22, y - 86, x + 27, y - 61, x + 17, y - 40, x + 27, y - 27, x + 27, y + 14], '#765557');
  rect(c, x - 12, y - 73, 30, 28, '#c4b29b', 3); rect(c, x - 8, y - 69, 22, 20, '#172e32', 2);
  for (let i = 0; i < 4; i++) rect(c, x - 3 + i * 4, y - 64 + i % 2 * 3, 3, 3, '#add59c');
  rect(c, x - 12, y - 83, 32, 6, '#ddad75'); rect(c, x - 17, y - 32, 37, 8, '#d8bb92', 2);
  ellipse(c, x + 8, y - 28, 3, 2, '#bb6670'); rect(c, x - 9, y - 39, 3, 9, '#564456');
}
function retro(c: Painter, h: number): void {
  shelf(c, 80, 69, 272, 2, '#795c50'); shelf(c, 805, 69, 272, 2, '#795c50');
  rect(c, 414, 47, 333, 130, '#a48a76', 8); rect(c, 424, 57, 313, 110, '#293936', 5);
  const stars = ['#d5b48a', '#80ae8b', '#b087a8'];
  for (let i = 0; i < 27; i++) rect(c, 438 + (i * 37) % 280, 65 + (i * 23) % 78, 3, 3, stars[i % 3]);
  for (let i = 0; i < 12; i++) rect(c, 441 + i * 23, 143 - i % 3 * 5, 16, 7, '#91b48a');
  for (const x of [489, 644]) { rect(c, x, 103, 14, 17, '#e5bd80'); rect(c, x - 3, 97, 20, 9, '#bb7d77'); rect(c, x + 3, 106, 3, 3, '#3c3439'); }
  rect(c, 555, 111, 49, 4, '#bf8d9a'); rect(c, 562, 94, 7, 21, '#bf8d9a'); rect(c, 587, 94, 7, 21, '#bf8d9a');
  rect(c, 25, 192, 1110, 8, '#c2a580');
  arcade(c, 54, 277); arcade(c, 1098, 277); arcade(c, 54, h - 86); arcade(c, 1098, h - 86);
  for (let y = 243, i = 0; y < h - 45; y += 42, i++) {
    rect(c, 555, y, 24, 24, i % 2 ? '#cfb99120' : '#292d3525'); rect(c, 579, y, 24, 24, i % 2 ? '#292d3525' : '#cfb99120');
  }
}

/** Static scene detail is painted once per cached room, never once per animation frame. */
export function paintIllustratedOffice(c: Painter, theme: OfficeThemeId, height: number): void {
  c.save();
  switch (theme) {
    case 'forest': forest(c, height); break;
    case 'library': library(c, height); break;
    case 'ocean': ocean(c, height); break;
    case 'zen': zen(c, height); break;
    case 'retro': retro(c, height); break;
  }
  c.restore();
}

export function paintThemedDeskDetails(c: Painter, theme: OfficeThemeId, x: number, y: number, p: OfficeThemePalette): void {
  if (theme === 'forest' || theme === 'zen') {
    rect(c, x - 48, y - 29, 13, 15, theme === 'forest' ? '#b29669' : '#859378', 3); branch(c, x - 41, y - 35, .35, '#597b52');
  } else if (theme === 'library') {
    rect(c, x - 48, y - 22, 20, 7, '#837da0', 2); rect(c, x - 45, y - 26, 16, 4, '#d8c2a1', 1);
    rect(c, x - 65, y - 42, 2, 19, '#dec49c'); path(c, [x - 66, y - 57, x - 79, y - 41, x - 53, y - 41], '#d4c295');
  } else if (theme === 'ocean') {
    rect(c, x - 46, y - 20, 24, 5, '#315f71', 2); for (let i = 0; i < 4; i++) rect(c, x - 43 + i * 5, y - 18, 3, 1, '#90d8c6');
  } else if (theme === 'retro') {
    rect(c, x - 48, y - 24, 27, 10, '#84777e', 5); rect(c, x - 42, y - 24, 3, 8, '#e7cdaa'); rect(c, x - 45, y - 21, 9, 3, '#e7cdaa');
    ellipse(c, x - 27, y - 21, 2, 2, '#c88784');
  }
  rect(c, x + 46, y - 8, 35, 4, p.monitor, 1);
  for (let i = 0; i < 6; i++) rect(c, x + 49 + i * 5, y - 7, 2, 1, '#ece7d680');
}
