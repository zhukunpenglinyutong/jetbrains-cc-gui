/**
 * Effective UI font configuration resolved by the Java backend.
 * Shared across global.d.ts, main.tsx, and settings hooks.
 */
export interface UiFontConfig {
  mode: 'followEditor' | 'customFile';
  effectiveMode: 'followEditor' | 'customFile';
  customFontPath?: string;
  fontFamily: string;
  displayName?: string;
  fontSize: number;
  lineSpacing: number;
  fallbackFonts?: string[];
  fontBase64?: string;
  fontFormat?: 'truetype' | 'opentype';
  warningCode?: 'fontUnavailable';
  warning?: string;
}
