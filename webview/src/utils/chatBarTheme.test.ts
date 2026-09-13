import { afterEach, describe, expect, it } from 'vitest';
import {
  applyChatBarThemeColor,
  CHAT_BAR_CSS_VARIABLES,
  isValidHexColor,
} from './chatBarTheme';

describe('chatBarTheme', () => {
  afterEach(() => {
    applyChatBarThemeColor('');
  });

  it('accepts only six-digit hex colors', () => {
    expect(isValidHexColor('#2b2d30')).toBe(true);
    expect(isValidHexColor('#ABCDEF')).toBe(true);
    expect(isValidHexColor('#fff')).toBe(false);
    expect(isValidHexColor('rgb(1, 2, 3)')).toBe(false);
  });

  it('applies the shared bar palette with readable text', () => {
    applyChatBarThemeColor('#1A1B26');

    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue(CHAT_BAR_CSS_VARIABLES.background)).toBe('#1a1b26');
    expect(rootStyle.getPropertyValue(CHAT_BAR_CSS_VARIABLES.text)).toBe('#ffffff');
    expect(rootStyle.getPropertyValue(CHAT_BAR_CSS_VARIABLES.hoverBackground)).not.toBe('');
    expect(rootStyle.getPropertyValue(CHAT_BAR_CSS_VARIABLES.activeBackground)).not.toBe('');
    expect(rootStyle.getPropertyValue(CHAT_BAR_CSS_VARIABLES.border)).not.toBe('');
  });

  it('uses dark text for a light custom color', () => {
    applyChatBarThemeColor('#f3f3f3');

    expect(document.documentElement.style.getPropertyValue(CHAT_BAR_CSS_VARIABLES.text)).toBe('#1f2328');
  });

  it('removes every override when reset or invalid', () => {
    applyChatBarThemeColor('#2b2d30');
    applyChatBarThemeColor('invalid');

    Object.values(CHAT_BAR_CSS_VARIABLES).forEach((variable) => {
      expect(document.documentElement.style.getPropertyValue(variable)).toBe('');
    });
  });
});
