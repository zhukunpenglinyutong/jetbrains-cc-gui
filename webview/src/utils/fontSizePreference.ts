import { sendBridgeEvent } from './bridge';
import { BRIDGE_READY_EVENT } from './bridgeStartup';
import { FONT_SIZE_LEVEL_STORAGE_KEY, fontSizeLevelToScale, isValidFontSizeLevel, parseFontSizeLevel } from './fontScale';
import { forceWebviewRepaint } from './forceWebviewRepaint';

export const FONT_SIZE_LEVEL_CHANGED_EVENT = 'font-size-level-changed';

let pendingLevel: number | null = null;
let currentLevel: number | null = null;
let hasExplicitSelection = false;
let selectionSequence = 0;
let latestRequestId: string | null = null;

function readCachedLevel(): string | null {
  try {
    return localStorage.getItem(FONT_SIZE_LEVEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getFontSizeLevel(): number {
  return currentLevel ?? parseFontSizeLevel(readCachedLevel());
}

export function subscribeFontSizeLevel(onChange: () => void): () => void {
  window.addEventListener(FONT_SIZE_LEVEL_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(FONT_SIZE_LEVEL_CHANGED_EVENT, onChange);
}

function applyLevel(level: number): void {
  const previousLevel = getFontSizeLevel();
  currentLevel = level;
  try {
    localStorage.setItem(FONT_SIZE_LEVEL_STORAGE_KEY, String(level));
  } catch {
    // Browser storage is a cache; quota or origin restrictions must not block Java persistence.
  }

  const scale = String(fontSizeLevelToScale(level));
  // Font callbacks and save acknowledgements can repeat an already applied scale.
  if (document.documentElement.style.getPropertyValue('--font-scale') !== scale) {
    document.documentElement.style.setProperty('--font-scale', scale);
    forceWebviewRepaint('font-scale-change');
  }
  if (previousLevel !== level) {
    window.dispatchEvent(new Event(FONT_SIZE_LEVEL_CHANGED_EVENT));
  }
}

function publishPendingLevel(): void {
  if (pendingLevel !== null) {
    sendBridgeEvent('set_font_size_level', JSON.stringify({
      fontSizeLevel: pendingLevel,
      fontSizeRequestId: latestRequestId,
    }));
  }
}

// Startup font injection can precede bridge readiness, including legacy migration.
window.addEventListener(BRIDGE_READY_EVENT, publishPendingLevel);

export function saveFontSizeLevel(level: number): void {
  if (!isValidFontSizeLevel(level)) return;
  hasExplicitSelection = true;
  latestRequestId = `${Date.now()}-${++selectionSequence}`;
  pendingLevel = level;
  applyLevel(level);
  publishPendingLevel();
}

/** Restore the backend preference without letting a late bootstrap undo a new selection. */
export function restoreFontSizeLevel(level: unknown, isStartup = false, requestId?: unknown): void {
  // Bootstrap is cached per page generation and may arrive after a save acknowledgement.
  if (isStartup && hasExplicitSelection) return;
  // Values alone cannot identify acknowledgements when a user selects A, B, A.
  if (requestId !== undefined && requestId !== latestRequestId) return;
  if (pendingLevel !== null && (level !== pendingLevel || requestId !== latestRequestId)) return;
  if (level === null) {
    // Migrate only an explicit legacy choice, never pin the current default on startup.
    const stored = readCachedLevel();
    if (stored !== null && /^\d+$/.test(stored) && isValidFontSizeLevel(Number(stored))) {
      saveFontSizeLevel(Number(stored));
    }
    return;
  }
  if (typeof level !== 'number' || !isValidFontSizeLevel(level)) return;
  pendingLevel = null;
  applyLevel(level);
}
