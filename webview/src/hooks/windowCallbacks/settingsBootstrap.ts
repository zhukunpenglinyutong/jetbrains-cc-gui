/**
 * settingsBootstrap.ts
 *
 * Handles initial configuration requests sent to the Java backend and the
 * processing of any values that arrived before the callbacks were registered
 * (stored in window.__pending* slots by main.tsx).
 */

import { sendBridgeEvent } from '../../utils/bridge';

const MAX_RETRIES = 30;

/**
 * Retry a callback until `window.sendToJava` is available.
 * Guards against timer firing after test environment teardown (jsdom removed).
 * Extracted to deduplicate the identical retry-with-timeout pattern (N2).
 */
const retryUntilBridgeReady = (action: () => void): void => {
  let retryCount = 0;
  const attempt = () => {
    if (typeof window === 'undefined') return;
    if (window.sendToJava) {
      action();
    } else {
      retryCount += 1;
      if (retryCount < MAX_RETRIES) {
        setTimeout(attempt, 100);
      }
    }
  };
  setTimeout(attempt, 200);
};

/**
 * Fire the three settings queries to the backend.  Retries up to MAX_RETRIES
 * times (at 100 ms intervals) if window.sendToJava is not yet available.
 */
export const startInitialSettingsRequest = (): void => {
  retryUntilBridgeReady(() => {
    // Non-null assertion safe: retryUntilBridgeReady only calls action() after
    // confirming window.sendToJava is truthy.
    window.sendToJava!('get_streaming_enabled:');
    window.sendToJava!('get_send_shortcut:');
    window.sendToJava!('get_auto_open_file_enabled:');
  });
};

/**
 * Request the active provider configuration.  Retries until sendToJava is
 * available.
 */
export const startActiveProviderRequest = (): void => {
  retryUntilBridgeReady(() => sendBridgeEvent('get_active_provider'));
};

/**
 * Request the current permission mode from the backend.
 */
export const startModeRequest = (): void => {
  retryUntilBridgeReady(() => sendBridgeEvent('get_mode'));
};

/**
 * Request the thinking-enabled setting from the backend.
 */
export const startThinkingEnabledRequest = (): void => {
  retryUntilBridgeReady(() => sendBridgeEvent('get_thinking_enabled'));
};

/**
 * Drain any pending window.__pending* values captured by main.tsx before
 * the React callbacks were registered.  Must be called after the corresponding
 * window.updateXxx / window.onXxx callbacks have been assigned.
 */
export const drainPendingSettings = (): void => {
  const w = window as unknown as Record<string, unknown>;

  if (w.__pendingStreamingEnabled) {
    const pending = w.__pendingStreamingEnabled as string;
    delete w.__pendingStreamingEnabled;
    window.updateStreamingEnabled?.(pending);
  }

  if (w.__pendingSendShortcut) {
    const pending = w.__pendingSendShortcut as string;
    delete w.__pendingSendShortcut;
    window.updateSendShortcut?.(pending);
  }

  if (w.__pendingAutoOpenFileEnabled) {
    const pending = w.__pendingAutoOpenFileEnabled as string;
    delete w.__pendingAutoOpenFileEnabled;
    window.updateAutoOpenFileEnabled?.(pending);
  }

  if (w.__pendingModeReceived) {
    const pending = w.__pendingModeReceived as string;
    delete w.__pendingModeReceived;
    window.onModeReceived?.(pending);
  }
};

/**
 * Drain any dependency-status payload that arrived before the callback was
 * registered, then trigger a fresh fetch.
 */
export const drainAndRequestDependencyStatus = (): void => {
  const w = window as unknown as Record<string, unknown>;

  if (w.__pendingDependencyStatus) {
    const pending = w.__pendingDependencyStatus as string;
    delete w.__pendingDependencyStatus;
    window.updateDependencyStatus?.(pending);
  }

  if (window.sendToJava) {
    window.sendToJava('get_dependency_status:');
  }
};
