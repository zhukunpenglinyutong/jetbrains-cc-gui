import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './codicon.css';
import './styles/app.less';
import './i18n/config';
import i18n from './i18n/config';
import { setupSlashCommandsCallback } from './components/ChatInputBox/providers/slashCommandProvider';
import { sendBridgeEvent } from './utils/bridge';

// Silence console output in production (including third-party libs).
// In dev, keep console for debugging.
if (!import.meta.env.DEV) {
  const noop = () => {};
  console.log = noop;
  console.debug = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
}

function createBridgeHeartbeatStarter() {
  let started = false;

  return () => {
    if (started) return;
    started = true;

    let lastRafAt = Date.now();
    let rafId: number | null = null;
    const rafLoop = () => {
      lastRafAt = Date.now();
      rafId = requestAnimationFrame(rafLoop);
    };
    rafId = requestAnimationFrame(rafLoop);

    let sequence = 0;
    const intervalMs = 5000;

    let intervalId: number | null = null;
    intervalId = window.setInterval(() => {
      sequence += 1;
      const payload = JSON.stringify({
        ts: Date.now(),
        raf: lastRafAt,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
        seq: sequence,
      });
      sendBridgeEvent('heartbeat', payload);
    }, intervalMs);

    const cleanup = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    // Explicitly cleanup timers on navigation/unload (best effort; helpful for long-running JCEF contexts).
    window.addEventListener('beforeunload', cleanup, { once: true });
    window.addEventListener('pagehide', cleanup, { once: true });

    // Cleanup on Vite HMR (dev only).
    if (import.meta.hot) {
      import.meta.hot.dispose(() => cleanup());
    }

    if (import.meta.env.DEV) {
      console.log('[Main] Bridge heartbeat enabled');
    }
  };
}

const startBridgeHeartbeat = createBridgeHeartbeatStarter();
// vConsole debugging tool
const enableVConsole =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_VCONSOLE === 'true';

if (enableVConsole) {
  void import('vconsole').then(({ default: VConsole }) => {
    new VConsole();
    // Move vConsole button to top-left corner to avoid blocking the send button in the bottom-right
    setTimeout(() => {
      const vcSwitch = document.getElementById('__vconsole') as HTMLElement;
      if (vcSwitch) {
        vcSwitch.style.left = '10px';
        vcSwitch.style.right = 'auto';
        vcSwitch.style.top = '10px';
        vcSwitch.style.bottom = 'auto';
      }
    }, 100);
  });
}

/**
 * Apply IDEA editor font configuration to CSS variables
 */
/**
 * JCEF (macOS) may occasionally render with an incorrect zoom/layout after the IDE
 * stays in background / screen-off for a while. The UI uses CSS `zoom` with an
 * inverse `vw/vh` container size to implement font scaling. If the zoom is not
 * applied correctly after resume, the container becomes smaller than the viewport,
 * leaving blank areas and causing "misalignment".
 *
 * This recovery nudges Chromium/JCEF to re-apply the expected zoom and triggers
 * a resize recalculation for components relying on window size.
 */
function setupScaleRecovery() {
  type CSSStyleDeclarationWithZoom = CSSStyleDeclaration & { zoom: string };

  const getExpectedScale = (): string => {
    const fromCss = getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
    if (fromCss) return fromCss;

    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 3;
    const fontSizeLevel = level >= 1 && level <= 6 ? level : 3;
    const fontSizeMap: Record<number, number> = {
      1: 0.8,
      2: 0.9,
      3: 1.0,
      4: 1.1,
      5: 1.2,
      6: 1.4,
    };
    return String(fontSizeMap[fontSizeLevel] || 1.0);
  };

  let hiddenAt: number | null = null;
  let lastRecoveryAt = 0;
  let scheduled = false;
  const RECOVERY_COOLDOWN_MS = 1500;

  const forceReapply = (reason: string) => {
    const app = document.getElementById('app') as HTMLElement | null;
    const expected = getExpectedScale();

    // Re-set the CSS variable to ensure width/height calc(100vw/scale) is refreshed.
    document.documentElement.style.setProperty('--font-scale', expected);

    const computedZoom = app
      ? (getComputedStyle(app) as unknown as CSSStyleDeclarationWithZoom).zoom
      : null;
    const computedZoomNumber = typeof computedZoom === 'string' ? parseFloat(computedZoom) : Number.NaN;
    const expectedNumber = parseFloat(expected);

    const needsZoomNudge =
      !!app &&
      Number.isFinite(expectedNumber) &&
      (!Number.isFinite(computedZoomNumber) || Math.abs(computedZoomNumber - expectedNumber) > 0.01);

    if (app && needsZoomNudge) {
      const appStyle = app.style as unknown as CSSStyleDeclarationWithZoom;
      // Toggle inline zoom to ensure Chromium/JCEF re-applies scaling after resume.
      // Keep the final value aligned with the CSS variable.
      appStyle.zoom = '1';
      // Force a sync layout.
      void app.offsetHeight;
      appStyle.zoom = expected;
    }

    // Let components recompute layout (some rely on window resize).
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      if (app && needsZoomNudge) {
        const appStyle = app.style as unknown as CSSStyleDeclarationWithZoom;
        // One more tick to reduce flakiness on macOS/JCEF.
        appStyle.zoom = expected;
      }
      if (import.meta.env.DEV) {
        console.log('[ScaleRecovery] Applied scale recovery:', {
          reason,
          expected,
          computedZoom,
          needsZoomNudge,
        });
      }
      lastRecoveryAt = Date.now();
    });
  };

  const schedule = (reason: string) => {
    if (scheduled || Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      forceReapply(reason);
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }

    const elapsed = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    // Only nudge after a meaningful pause to avoid unnecessary work during normal tab switches.
    if (elapsed > 1500) {
      schedule('visibilitychange-resume');
    }
  });

  window.addEventListener('focus', () => {
    // Focus can return without a visibilitychange in some IDE/window states.
    schedule('window-focus');
  });

  window.addEventListener('pageshow', () => {
    // Helps if the page is restored from bfcache-like behavior.
    schedule('pageshow');
  });
}

function applyFontConfig(config: { fontFamily: string; fontSize: number; lineSpacing: number; fallbackFonts?: string[] }) {
  const root = document.documentElement;

  // Build font family string with primary font, fallback fonts, and system defaults
  const fontParts: string[] = [`'${config.fontFamily}'`];

  // Add IDEA-configured fallback fonts
  if (config.fallbackFonts && config.fallbackFonts.length > 0) {
    for (const fallback of config.fallbackFonts) {
      fontParts.push(`'${fallback}'`);
    }
  }

  // Add system default fallback fonts
  fontParts.push("'Consolas'", 'monospace');

  const fontFamily = fontParts.join(', ');

  root.style.setProperty('--idea-editor-font-family', fontFamily);
  root.style.setProperty('--idea-editor-font-size', `${config.fontSize}px`);
  root.style.setProperty('--idea-editor-line-spacing', String(config.lineSpacing));

  console.log('[Main] Applied IDEA font config:', config, 'fontFamily CSS:', fontFamily);
}

// Register the applyIdeaFontConfig function
window.applyIdeaFontConfig = applyFontConfig;

// Check for pending font config (Java side may execute before JS)
if (window.__pendingFontConfig) {
  console.log('[Main] Found pending font config, applying...');
  applyFontConfig(window.__pendingFontConfig);
  delete window.__pendingFontConfig;
}

/**
 * Apply IDEA language configuration to i18n
 * Only applies IDEA language if user hasn't manually set a language preference
 */
function applyLanguageConfig(config: { language: string; ideaLocale?: string }) {
  const { language } = config;

  // Check if user has manually set a language preference
  const manuallySet = localStorage.getItem('languageManuallySet') === 'true';
  if (manuallySet) {
    console.log('[Main] User has manually set language preference, skipping IDEA language config');
    return;
  }

  // Validate that the language code is supported
  const supportedLanguages = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja', 'ru'];
  const targetLanguage = supportedLanguages.includes(language) ? language : 'en';

  console.log('[Main] Applying IDEA language config:', config, 'target language:', targetLanguage);

  // Switch i18n language
  i18n.changeLanguage(targetLanguage)
    .then(() => {
      // Persist to localStorage so it's available on next launch
      localStorage.setItem('language', targetLanguage);
      console.log('[Main] Language changed successfully to:', targetLanguage);
    })
    .catch((error) => {
      console.error('[Main] Failed to change language:', error);
    });
}

// Register the applyIdeaLanguageConfig function
window.applyIdeaLanguageConfig = applyLanguageConfig;

// Check for pending language config (Java side may execute before JS)
if (window.__pendingLanguageConfig) {
  console.log('[Main] Found pending language config, applying...');
  applyLanguageConfig(window.__pendingLanguageConfig);
  delete window.__pendingLanguageConfig;
}

// Pre-register updateSlashCommands to handle backend calls that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateSlashCommands) {
  console.log('[Main] Pre-registering updateSlashCommands placeholder');
  window.updateSlashCommands = (json: string) => {
    console.log('[Main] Storing pending slash commands, length=' + json.length);
    window.__pendingSlashCommands = json;
  };
}

// Pre-register setSessionId to handle backend calls that arrive before React initializes.
// This stores the session ID required by the rewind feature.
if (typeof window !== 'undefined' && !window.setSessionId) {
  console.log('[Main] Pre-registering setSessionId placeholder');
  window.setSessionId = (sessionId: string) => {
    console.log('[Main] Storing pending session ID:', sessionId);
    (window as any).__pendingSessionId = sessionId;
  };
}

// Pre-register updateDependencyStatus to handle backend status responses that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateDependencyStatus) {
  console.log('[Main] Pre-registering updateDependencyStatus placeholder');
  window.updateDependencyStatus = (json: string) => {
    console.log('[Main] Storing pending dependency status, length=' + (json ? json.length : 0));
    window.__pendingDependencyStatus = json;
  };
}

// Pre-register dependencyUpdateAvailable to handle backend update checks that arrive before Settings/React initializes
if (typeof window !== 'undefined' && !window.dependencyUpdateAvailable) {
  console.log('[Main] Pre-registering dependencyUpdateAvailable placeholder');
  window.dependencyUpdateAvailable = (json: string) => {
    console.log('[Main] Storing pending dependency updates, length=' + (json ? json.length : 0));
    window.__pendingDependencyUpdates = json;
  };
}

// Pre-register updateStreamingEnabled to handle backend status responses that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateStreamingEnabled) {
  console.log('[Main] Pre-registering updateStreamingEnabled placeholder');
  window.updateStreamingEnabled = (json: string) => {
    console.log('[Main] Storing pending streaming enabled status, length=' + (json ? json.length : 0));
    window.__pendingStreamingEnabled = json;
  };
}

// Pre-register updateSendShortcut to handle backend status responses that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateSendShortcut) {
  console.log('[Main] Pre-registering updateSendShortcut placeholder');
  window.updateSendShortcut = (json: string) => {
    console.log('[Main] Storing pending send shortcut status, length=' + (json ? json.length : 0));
    window.__pendingSendShortcut = json;
  };
}

// Pre-register updateUsageStatistics to handle backend status responses that arrive before Settings/UsageStatisticsSection initializes
if (typeof window !== 'undefined' && !window.updateUsageStatistics) {
  console.log('[Main] Pre-registering updateUsageStatistics placeholder');
  window.updateUsageStatistics = (json: string) => {
    console.log('[Main] Storing pending usage statistics, length=' + (json ? json.length : 0));
    window.__pendingUsageStatistics = json;
  };
}

if (typeof window !== 'undefined' && !window.showPermissionDialog) {
  console.log('[Main] Pre-registering showPermissionDialog placeholder');
  window.showPermissionDialog = (json: string) => {
    const pending = window.__pendingPermissionDialogRequests || [];
    pending.push(json);
    window.__pendingPermissionDialogRequests = pending;
  };
}

if (typeof window !== 'undefined' && !window.showAskUserQuestionDialog) {
  console.log('[Main] Pre-registering showAskUserQuestionDialog placeholder');
  window.showAskUserQuestionDialog = (json: string) => {
    const pending = window.__pendingAskUserQuestionDialogRequests || [];
    pending.push(json);
    window.__pendingAskUserQuestionDialogRequests = pending;
  };
}

if (typeof window !== 'undefined' && !window.showPlanApprovalDialog) {
  console.log('[Main] Pre-registering showPlanApprovalDialog placeholder');
  window.showPlanApprovalDialog = (json: string) => {
    const pending = window.__pendingPlanApprovalDialogRequests || [];
    pending.push(json);
    window.__pendingPlanApprovalDialogRequests = pending;
  };
}

// Render the React application
ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

/**
 * Wait for the sendToJava bridge function to become available
 */
setupScaleRecovery();

function waitForBridge(callback: () => void, maxAttempts = 50, interval = 100) {
  let attempts = 0;

  const check = () => {
    attempts++;
    if (window.sendToJava) {
      console.log('[Main] Bridge available after ' + attempts + ' attempts');
      callback();
    } else if (attempts < maxAttempts) {
      setTimeout(check, interval);
    } else {
      console.error('[Main] Bridge not available after ' + maxAttempts + ' attempts');
    }
  };

  check();
}

// Once the bridge is available, initialize slash commands
waitForBridge(() => {
  console.log('[Main] Bridge ready, setting up slash commands');
  setupSlashCommandsCallback();
  startBridgeHeartbeat();

  console.log('[Main] Sending frontend_ready signal');
  sendBridgeEvent('frontend_ready');

  console.log('[Main] Sending refresh_slash_commands request');
  sendBridgeEvent('refresh_slash_commands');

  // Ensure SDK dependency status is fetched on initial load (not only after opening Settings).
  console.log('[Main] Requesting dependency status');
  sendBridgeEvent('get_dependency_status');
});
