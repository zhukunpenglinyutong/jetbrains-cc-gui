/**
 * Pending window slot pre-registration module.
 *
 * The Java backend may invoke window callbacks (e.g. `updateMessages`) before
 * React has finished mounting and registering its own handlers. To avoid losing
 * those early payloads we install lightweight placeholder functions that store
 * incoming data on `window.__pending*` properties. React components later read
 * and consume these pending values during initialisation.
 */

import { debugLog } from '../utils/debug';

// ---------------------------------------------------------------------------
// Generic utility
// ---------------------------------------------------------------------------

/**
 * Pre-register a window callback so that calls arriving before React mounts
 * are captured as a pending value on `window`.
 *
 * @param windowKey  - The method name on `window` (e.g. 'updateMessages')
 * @param pendingKey - The `window.__pending*` property name (e.g. '__pendingUpdateMessages')
 * @param handler    - Called with the value(s) and must write to `window[pendingKey]`
 */
function preRegisterWindowSlot<T extends (...args: any[]) => void>(
  windowKey: keyof Window,
  _pendingKey: string,
  handler: T,
): void {
  if (typeof window !== 'undefined' && !(window as any)[windowKey]) {
    debugLog(`[Main] Pre-registering ${String(windowKey)} placeholder`);
    (window as any)[windowKey] = handler;
  }
}

// ---------------------------------------------------------------------------
// Public init function
// ---------------------------------------------------------------------------

/**
 * Register all pre-mount placeholder callbacks for the Java <-> JS bridge.
 */
export function registerPendingSlots() {
  // --- updateMessages (complex: sequence handling) ---
  preRegisterWindowSlot(
    'updateMessages',
    '__pendingUpdateMessages',
    (json: string, sequence?: string | number) => {
      const parsedSequence =
        typeof sequence === 'number'
          ? sequence
          : typeof sequence === 'string' && sequence.trim().length > 0
            ? Number.parseInt(sequence, 10)
            : null;
      window.__pendingUpdateMessages = {
        json,
        sequence: Number.isFinite(parsedSequence) ? parsedSequence : null,
      };
    },
  );

  // --- updateStatus ---
  preRegisterWindowSlot(
    'updateStatus',
    '__pendingStatusText',
    (text: string) => {
      window.__pendingStatusText = text;
    },
  );

  // --- showLoading ---
  preRegisterWindowSlot(
    'showLoading',
    '__pendingLoadingState',
    (value: string | boolean) => {
      window.__pendingLoadingState = value === true || value === 'true';
    },
  );

  // --- addUserMessage ---
  preRegisterWindowSlot(
    'addUserMessage',
    '__pendingUserMessage',
    (content: string) => {
      window.__pendingUserMessage = content;
    },
  );

  // --- showSummary ---
  preRegisterWindowSlot(
    'showSummary',
    '__pendingSummaryText',
    (summary: string) => {
      window.__pendingSummaryText = summary;
    },
  );

  // --- updateSlashCommands ---
  preRegisterWindowSlot(
    'updateSlashCommands',
    '__pendingSlashCommands',
    (json: string) => {
      debugLog('[Main] Storing pending slash commands, length=' + json.length);
      window.__pendingSlashCommands = json;
    },
  );

  // --- updateDollarCommands ---
  preRegisterWindowSlot(
    'updateDollarCommands',
    '__pendingDollarCommands',
    (json: string) => {
      window.__pendingDollarCommands = json;
    },
  );

  // --- setSessionId ---
  preRegisterWindowSlot(
    'setSessionId',
    '__pendingSessionId',
    (sessionId: string) => {
      debugLog('[Main] Storing pending session ID:', sessionId);
      window.__pendingSessionId = sessionId;
    },
  );

  // --- updateDependencyStatus ---
  preRegisterWindowSlot(
    'updateDependencyStatus',
    '__pendingDependencyStatus',
    (json: string) => {
      debugLog('[Main] Storing pending dependency status, length=' + (json ? json.length : 0));
      window.__pendingDependencyStatus = json;
    },
  );

  // --- dependencyUpdateAvailable ---
  preRegisterWindowSlot(
    'dependencyUpdateAvailable',
    '__pendingDependencyUpdates',
    (json: string) => {
      debugLog('[Main] Storing pending dependency updates, length=' + (json ? json.length : 0));
      window.__pendingDependencyUpdates = json;
    },
  );

  // --- updateStreamingEnabled ---
  preRegisterWindowSlot(
    'updateStreamingEnabled',
    '__pendingStreamingEnabled',
    (json: string) => {
      debugLog('[Main] Storing pending streaming enabled status, length=' + (json ? json.length : 0));
      window.__pendingStreamingEnabled = json;
    },
  );

  // --- updateSendShortcut ---
  preRegisterWindowSlot(
    'updateSendShortcut',
    '__pendingSendShortcut',
    (json: string) => {
      debugLog('[Main] Storing pending send shortcut status, length=' + (json ? json.length : 0));
      window.__pendingSendShortcut = json;
    },
  );

  // --- updatePermissionDialogTimeout ---
  preRegisterWindowSlot(
    'updatePermissionDialogTimeout',
    '__pendingPermissionDialogTimeout',
    (json: string) => {
      debugLog('[Main] Storing pending permission dialog timeout, length=' + (json ? json.length : 0));
      window.__pendingPermissionDialogTimeout = json;
    },
  );

  // --- updateUsageStatistics ---
  preRegisterWindowSlot(
    'updateUsageStatistics',
    '__pendingUsageStatistics',
    (json: string) => {
      debugLog('[Main] Storing pending usage statistics, length=' + (json ? json.length : 0));
      window.__pendingUsageStatistics = json;
    },
  );

  // --- onModeReceived ---
  preRegisterWindowSlot(
    'onModeReceived',
    '__pendingModeReceived',
    (mode: string) => {
      debugLog('[Main] Storing pending mode:', mode);
      window.__pendingModeReceived = mode;
    },
  );

  // --- showPermissionDialog (accumulator: pushes to array) ---
  preRegisterWindowSlot(
    'showPermissionDialog',
    '__pendingPermissionDialogRequests',
    (json: string) => {
      const pending = window.__pendingPermissionDialogRequests || [];
      pending.push(json);
      window.__pendingPermissionDialogRequests = pending;
    },
  );

  // --- showAskUserQuestionDialog (accumulator: pushes to array) ---
  preRegisterWindowSlot(
    'showAskUserQuestionDialog',
    '__pendingAskUserQuestionDialogRequests',
    (json: string) => {
      const pending = window.__pendingAskUserQuestionDialogRequests || [];
      pending.push(json);
      window.__pendingAskUserQuestionDialogRequests = pending;
    },
  );

  // --- showPlanApprovalDialog (accumulator: pushes to array) ---
  preRegisterWindowSlot(
    'showPlanApprovalDialog',
    '__pendingPlanApprovalDialogRequests',
    (json: string) => {
      const pending = window.__pendingPlanApprovalDialogRequests || [];
      pending.push(json);
      window.__pendingPlanApprovalDialogRequests = pending;
    },
  );
}
