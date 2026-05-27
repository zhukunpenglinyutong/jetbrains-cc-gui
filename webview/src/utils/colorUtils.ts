export const isValidHexColor = (c: string): boolean => /^#[0-9a-fA-F]{6}$/.test(c);

export function hexToRgb(hex: string): string {
  if (!isValidHexColor(hex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}
