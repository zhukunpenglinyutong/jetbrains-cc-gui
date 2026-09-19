import type { CommandItem, DropdownItemData } from '../types';
import { debugLog, debugWarn } from '../../../utils/debug.js';
import i18n from '../../../i18n/config';

// ============================================================================
// State Management
// ============================================================================

interface DollarCommandItem {
  name: string;
  description?: string;
  type?: string;
  source?: string;
}

function isDollarCommandItem(value: unknown): value is DollarCommandItem {
  if (typeof value !== 'object' || value === null) return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 && name.length <= 128;
}

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedCommands: CommandItem[] = [];
let loadingState: LoadingState = 'idle';
let callbackRegistered = false;
let pendingWaiters: Array<() => void> = [];
// Match slash-command wait: Codex skill scan is local but can hitch on large trees,
// and the merged picker would otherwise return commands while skills are still in flight.
const LOADING_TIMEOUT = 30000;

function notifyDollarWaiters(): void {
  const waiters = pendingWaiters;
  pendingWaiters = [];
  waiters.forEach(resolve => resolve());
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Reset $ command state (call on provider switch).
 */
export function resetDollarCommandsState() {
  cachedCommands = [];
  loadingState = 'idle';
  callbackRegistered = false;
  notifyDollarWaiters();
  // Clear the window callback to prevent handler chain growth on repeated provider switches
  if (typeof window !== 'undefined') {
    delete window.updateDollarCommands;
  }
  debugLog('[DollarCommand] State reset');
}

/**
 * Register window.updateDollarCommands callback to receive $ commands from backend.
 */
export function setupDollarCommandsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateDollarCommands) return;

  loadingState = 'loading';

  const handler = (json: string) => {
    debugLog('[DollarCommand] Received data from backend, length=' + (typeof json === 'string' ? json.length : 0));
    try {
      if (typeof json !== 'string') {
        throw new Error('Dollar commands payload must be a string');
      }
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) {
        debugWarn('[DollarCommand] Invalid payload (not array)');
        loadingState = 'failed';
        notifyDollarWaiters();
        return;
      }

      cachedCommands = parsed.flatMap(item => {
        if (!isDollarCommandItem(item)) {
          return [];
        }
        return [{
          id: item.name.replace(/^\$/, ''),
          label: item.name.startsWith('$') ? item.name : `$${item.name}`,
          description: typeof item.description === 'string'
            ? item.description.substring(0, 1024)
            : '',
          category: 'skill',
          contentType: (typeof item.type === 'string' && item.type.toLowerCase() === 'command')
            || (typeof item.source === 'string' && item.source.toLowerCase() === 'codex-command')
            ? 'command'
            : 'skill',
        }];
      });

      loadingState = 'success';
      notifyDollarWaiters();
      debugLog('[DollarCommand] Loaded ' + cachedCommands.length + ' commands');
    } catch (error) {
      loadingState = 'failed';
      notifyDollarWaiters();
      debugWarn('[DollarCommand] Failed to parse commands: ' + error);
    }
  };

  // Preserve original handler for chaining (e.g., main.tsx placeholder)
  const originalHandler = window.updateDollarCommands;

  window.updateDollarCommands = (json: string) => {
    handler(json);
    originalHandler?.(json);
  };
  callbackRegistered = true;
  debugLog('[DollarCommand] Callback registered');

  // Process pending data if backend sent before callback was registered
  if (window.__pendingDollarCommands) {
    debugLog('[DollarCommand] Processing pending commands');
    const pending = window.__pendingDollarCommands;
    window.__pendingDollarCommands = undefined;
    handler(pending);
  }
}

function waitForDollarCommands(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (loadingState === 'success' || loadingState === 'failed') {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const cleanup = () => {
      pendingWaiters = pendingWaiters.filter(item => item !== settle);
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      // Fail fast on later queries instead of re-waiting the full timeout each
      // keystroke when the backend never pushes the dollar payload. A late
      // payload still recovers through the registered handler.
      if (loadingState !== 'success' && loadingState !== 'failed') {
        loadingState = 'failed';
        debugWarn('[DollarCommand] Loading timeout');
        notifyDollarWaiters();
      }
      resolve();
    }, timeoutMs);

    const settle = () => {
      cleanup();
      resolve();
    };

    signal.addEventListener('abort', onAbort, { once: true });
    pendingWaiters.push(settle);
    if (loadingState === 'success' || loadingState === 'failed') {
      settle();
    }
  });
}

/**
 * Dollar command provider for $ autocomplete.
 * Filters cached commands by query string.
 */
export async function dollarCommandProvider(
  query: string,
  signal: AbortSignal
): Promise<CommandItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupDollarCommandsCallback();

  if (loadingState !== 'success' && loadingState !== 'failed') {
    await waitForDollarCommands(signal, LOADING_TIMEOUT);
  }

  if (loadingState === 'success') {
    if (!query) return cachedCommands;

    const lowerQuery = query.toLowerCase();
    return cachedCommands.filter(
      cmd =>
        cmd.label.toLowerCase().includes(lowerQuery) ||
        cmd.description?.toLowerCase().includes(lowerQuery)
    );
  }

  if (loadingState === 'failed') {
    return [{
      id: '__error__',
      label: i18n.t('chat.loadingFailed'),
      description: i18n.t('chat.pleaseCloseAndReopen'),
      category: 'system',
    }];
  }

  // loading or idle
  return [{
    id: '__loading__',
    label: i18n.t('chat.loadingSlashCommands'),
    description: i18n.t('chat.pleaseWait'),
    category: 'system',
  }];
}

/**
 * Convert a $ command CommandItem to a DropdownItemData.
 */
export function dollarCommandToDropdownItem(cmd: CommandItem): DropdownItemData {
  return {
    id: cmd.id,
    label: cmd.label,
    description: cmd.description,
    icon: 'codicon-symbol-event',
    type: 'command',
    data: { command: cmd },
  };
}

export default dollarCommandProvider;
