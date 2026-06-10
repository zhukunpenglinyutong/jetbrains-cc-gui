import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { MessagesProvider } from './contexts/MessagesContext';
import { SessionProvider } from './contexts/SessionContext';
import { UIStateProvider } from './contexts/UIStateContext';
import { DialogProvider } from './contexts/DialogContext';
import './codicon.css';
import './styles/app.less';
import './i18n/config';
import { setupSlashCommandsCallback } from './components/ChatInputBox/providers/slashCommandProvider';
import { setupDollarCommandsCallback } from './components/ChatInputBox/providers/dollarCommandProvider';
import { applyLinkifyCapabilitiesPayload } from './utils/linkifyCapabilities';
import { installRuntimeProviderDispatchers } from './utils/runtimeProviderCapabilities';
import { sendBridgeEvent } from './utils/bridge';
import { debugLog } from './utils/debug';

// Bootstrap modules
import { startBridgeHeartbeat } from './bootstrap/bridge';
import { initScaleRecovery } from './bootstrap/scaleRecovery';
import { initFonts } from './bootstrap/fonts';
import { initLanguage } from './bootstrap/language';
import { registerPendingSlots } from './bootstrap/pendingSlots';

// Silence noisy console output in production (including third-party libs).
// console.error is preserved so ErrorBoundary and unhandled exceptions still
// surface in the IDE's webview devtools — silencing it would hide regressions.
if (!import.meta.env.DEV) {
  const noop = () => {};
  console.log = noop;
  console.debug = noop;
  console.info = noop;
  console.warn = noop;
}

// Install the runtime provider dispatcher exactly once so that every
// consumer (Settings, RuntimeProviderSelect, …) receives provider events
// through a deterministic subscriber registry instead of overriding
// `window.update*Provider*` callbacks ad-hoc.
installRuntimeProviderDispatchers();

// ---------------------------------------------------------------------------
// Bootstrap initialisation (order matters)
// ---------------------------------------------------------------------------

// Font config handlers must be ready before the Java bridge calls them.
initFonts();

// Language config handler must be ready before the Java bridge calls it.
initLanguage();

// Pre-register window callback placeholders so that bridge calls arriving
// before React mounts are not lost.
registerPendingSlots();

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

// Register linkify capabilities handler (non-pending, immediate setup)
if (typeof window !== 'undefined') {
  window.updateLinkifyCapabilities = (json: string) => {
    applyLinkifyCapabilitiesPayload(json);
  };
}

// ---------------------------------------------------------------------------
// React application rendering
// ---------------------------------------------------------------------------

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <ErrorBoundary>
    <UIStateProvider>
      <SessionProvider>
        <MessagesProvider>
          <DialogProvider>
            <App />
          </DialogProvider>
        </MessagesProvider>
      </SessionProvider>
    </UIStateProvider>
  </ErrorBoundary>,
);

// ---------------------------------------------------------------------------
// Post-render bootstrap
// ---------------------------------------------------------------------------

// Scale recovery listens for visibility/focus events to fix JCEF zoom glitches.
initScaleRecovery();

/**
 * Wait for the sendToJava bridge function to become available
 */
function waitForBridge(callback: () => void, maxAttempts = 50, interval = 100) {
  let attempts = 0;

  const check = () => {
    attempts++;
    if (window.sendToJava) {
      debugLog('[Main] Bridge available after ' + attempts + ' attempts');
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
  debugLog('[Main] Bridge ready, setting up slash commands');
  setupSlashCommandsCallback();
  setupDollarCommandsCallback();
  startBridgeHeartbeat();

  debugLog('[Main] Sending frontend_ready signal');
  sendBridgeEvent('frontend_ready');

  debugLog('[Main] Sending refresh_slash_commands request');
  sendBridgeEvent('refresh_slash_commands');

  // Ensure SDK dependency status is fetched on initial load (not only after opening Settings).
  debugLog('[Main] Requesting dependency status');
  sendBridgeEvent('get_dependency_status');

  sendBridgeEvent('get_linkify_capabilities');
});
