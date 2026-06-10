/**
 * Font configuration bootstrap module.
 *
 * Manages IDEA editor font and plugin UI font configuration, including:
 * - CSS variable updates for font family, size, and line spacing
 * - Custom @font-face injection for user-provided font files
 * - Synchronizing effective UI font family (editor vs. custom)
 */
import { debugLog } from '../utils/debug';
import type { UiFontConfig } from '../types/uiFontConfig';

// ---------------------------------------------------------------------------
// State (module-scoped)
// ---------------------------------------------------------------------------

let latestEditorFontConfig: {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  fallbackFonts?: string[];
} | null = null;

let latestUiFontConfig: UiFontConfig | null = null;

const UI_FONT_STYLE_ELEMENT_ID = 'cc-gui-font-face-style';

let currentFontBlobUrl: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeCssFontName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildFontFamilyValue(config: { fontFamily: string; fallbackFonts?: string[] }) {
  const fontParts: string[] = [`'${escapeCssFontName(config.fontFamily)}'`];

  if (config.fallbackFonts && config.fallbackFonts.length > 0) {
    for (const fallback of config.fallbackFonts) {
      fontParts.push(`'${escapeCssFontName(fallback)}'`);
    }
  }

  fontParts.push("'Consolas'", 'monospace');
  return fontParts.join(', ');
}

function escapeCssUrl(url: string): string {
  return url.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n|\r/g, '');
}

function createFontBlobUrl(base64: string, format: string): string {
  const mimeType = format === 'opentype' ? 'font/opentype' : 'font/truetype';
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------------------
// Internal application functions
// ---------------------------------------------------------------------------

function setUiFontFaceStyle(config: UiFontConfig) {
  let styleElement = document.getElementById(UI_FONT_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = UI_FONT_STYLE_ELEMENT_ID;
    document.head.appendChild(styleElement);
  }

  // Revoke previous blob URL to free memory
  if (currentFontBlobUrl) {
    URL.revokeObjectURL(currentFontBlobUrl);
    currentFontBlobUrl = null;
  }

  if (!config.fontUrl && (!config.fontBase64 || !config.fontFormat)) {
    styleElement.textContent = '';
    return;
  }

  const fontFormat = config.fontFormat || 'truetype';
  let fontSourceUrl = config.fontUrl;
  if (!fontSourceUrl && config.fontBase64) {
    fontSourceUrl = createFontBlobUrl(config.fontBase64, fontFormat);
    currentFontBlobUrl = fontSourceUrl;
  }

  const familyName = escapeCssFontName('CC GUI Custom');
  styleElement.textContent =
    `@font-face { font-family: '${familyName}'; font-style: normal; font-weight: 100 900;` +
    ` font-display: swap; src: url("${escapeCssUrl(fontSourceUrl || '')}") format('${fontFormat}'); }`;
}

function syncEffectiveUiFontFamily() {
  const root = document.documentElement;
  const shouldFollowEditor =
    !latestUiFontConfig || latestUiFontConfig.effectiveMode === 'followEditor';

  const sourceConfig = shouldFollowEditor
    ? latestEditorFontConfig || latestUiFontConfig
    : latestUiFontConfig;

  if (!sourceConfig) {
    return;
  }

  const fontFamilyValue = buildFontFamilyValue({
    fontFamily: sourceConfig.fontFamily,
    fallbackFonts: sourceConfig.fallbackFonts ?? latestEditorFontConfig?.fallbackFonts,
  });

  root.style.setProperty('--cc-gui-ui-font-family', fontFamilyValue);
  // Keep legacy variable in sync so existing components continue to pick up the effective UI font.
  root.style.setProperty('--idea-editor-font-family', fontFamilyValue);
}

function applyEditorTypographyConfig(config: {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  fallbackFonts?: string[];
}) {
  const root = document.documentElement;
  latestEditorFontConfig = config;
  root.style.setProperty('--cc-gui-editor-font-family', buildFontFamilyValue(config));
  root.style.setProperty('--idea-editor-font-size', `${config.fontSize}px`);
  root.style.setProperty('--idea-editor-line-spacing', String(config.lineSpacing));
  syncEffectiveUiFontFamily();
}

function applyUiFontConfig(config: UiFontConfig | string) {
  const normalizedConfig: UiFontConfig =
    typeof config === 'string' ? JSON.parse(config) as UiFontConfig : config;

  latestUiFontConfig = normalizedConfig;
  setUiFontFaceStyle(normalizedConfig);
  syncEffectiveUiFontFamily();
}

// ---------------------------------------------------------------------------
// Public init function
// ---------------------------------------------------------------------------

/**
 * Register global font config handlers and apply any pending configs that
 * were delivered by the Java side before JS finished loading.
 */
export function initFonts() {
  // Register the applyIdeaFontConfig function
  window.applyIdeaFontConfig = applyEditorTypographyConfig;
  window.applyUiFontConfig = applyUiFontConfig;

  // Check for pending font config (Java side may execute before JS)
  if (window.__pendingFontConfig) {
    debugLog('[Main] Found pending font config, applying...');
    applyEditorTypographyConfig(window.__pendingFontConfig);
    delete window.__pendingFontConfig;
  }

  if (window.__pendingUiFontConfig) {
    debugLog('[Main] Found pending UI font config, applying...');
    applyUiFontConfig(window.__pendingUiFontConfig);
    delete window.__pendingUiFontConfig;
  }
}
