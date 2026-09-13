export const CHAT_BAR_COLOR_STORAGE_KEY = 'chatBarColor';

export const CHAT_BAR_CSS_VARIABLES = {
  background: '--color-chat-bars-bg',
  hoverBackground: '--color-chat-bars-hover-bg',
  activeBackground: '--color-chat-bars-active-bg',
  border: '--color-chat-bars-border',
  text: '--color-chat-bars-text',
  mutedText: '--color-chat-bars-muted-text',
} as const;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const LIGHT_TEXT = '#ffffff';
const DARK_TEXT = '#1f2328';

type Rgb = [number, number, number];

export function isValidHexColor(color: string): boolean {
  return HEX_COLOR_PATTERN.test(color);
}

function hexToRgb(color: string): Rgb {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function rgbToHex([red, green, blue]: Rgb): string {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixColors(base: string, overlay: string, overlayRatio: number): string {
  const baseRgb = hexToRgb(base);
  const overlayRgb = hexToRgb(overlay);
  return rgbToHex(baseRgb.map((channel, index) => (
    channel * (1 - overlayRatio) + overlayRgb[index] * overlayRatio
  )) as Rgb);
}

function relativeLuminance(color: string): number {
  const channels = hexToRgb(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function getReadableTextColor(background: string): string {
  return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT)
    ? LIGHT_TEXT
    : DARK_TEXT;
}

export function applyChatBarThemeColor(color: string, root: HTMLElement = document.documentElement): void {
  if (!isValidHexColor(color)) {
    Object.values(CHAT_BAR_CSS_VARIABLES).forEach((variable) => {
      root.style.removeProperty(variable);
    });
    return;
  }

  const normalizedColor = color.toLowerCase();
  const textColor = getReadableTextColor(normalizedColor);

  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.background, normalizedColor);
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.hoverBackground, mixColors(normalizedColor, textColor, 0.08));
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.activeBackground, mixColors(normalizedColor, textColor, 0.14));
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.border, mixColors(normalizedColor, textColor, 0.24));
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.text, textColor);
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.mutedText, mixColors(normalizedColor, textColor, 0.72));
}
