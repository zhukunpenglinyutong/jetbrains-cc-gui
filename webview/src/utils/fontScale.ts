// Single source of truth for the chat font-size level (1-6). The level table,
// valid range and default used to be duplicated across useThemeInit,
// useSettingsThemeSync and main.tsx getExpectedScale(), which let the default
// drift apart between them.

export const FONT_SIZE_LEVEL_STORAGE_KEY = 'fontSizeLevel';

export const MIN_FONT_SIZE_LEVEL = 1;
export const MAX_FONT_SIZE_LEVEL = 6;
export const DEFAULT_FONT_SIZE_LEVEL = 3; // 100%

export const FONT_SIZE_LEVEL_MAP: Record<number, number> = {
  1: 0.8,
  2: 0.9,
  3: 1.0,
  4: 1.1,
  5: 1.2,
  6: 1.4,
};

export function isValidFontSizeLevel(level: number): boolean {
  return Number.isInteger(level)
    && level >= MIN_FONT_SIZE_LEVEL
    && level <= MAX_FONT_SIZE_LEVEL;
}

export function fontSizeLevelToScale(level: number): number {
  return FONT_SIZE_LEVEL_MAP[level] ?? 1.0;
}

export function parseFontSizeLevel(rawLevel: string | null): number {
  if (!rawLevel) {
    return DEFAULT_FONT_SIZE_LEVEL;
  }
  const parsed = parseInt(rawLevel, 10);
  return isValidFontSizeLevel(parsed) ? parsed : DEFAULT_FONT_SIZE_LEVEL;
}
