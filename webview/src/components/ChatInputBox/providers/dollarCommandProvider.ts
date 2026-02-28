import type { CommandItem, DropdownItemData } from '../types';
import { debugLog, debugWarn } from '../../../utils/debug.js';

// ============================================================================
// State Management
// ============================================================================

interface DollarCommandItem {
  name: string;
  description?: string;
}

let cachedCommands: CommandItem[] = [];
let callbackRegistered = false;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Reset $ command state (call on provider switch).
 */
export function resetDollarCommandsState() {
  cachedCommands = [];
  callbackRegistered = false;
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

  const handler = (json: string) => {
    debugLog('[DollarCommand] Received data from backend, length=' + json.length);
    try {
      const parsed: DollarCommandItem[] = JSON.parse(json);
      if (!Array.isArray(parsed)) {
        debugWarn('[DollarCommand] Invalid payload (not array)');
        return;
      }

      cachedCommands = parsed
        .filter(item =>
          typeof item === 'object' && item !== null &&
          typeof item.name === 'string' && item.name.length > 0 &&
          item.name.length <= 128
        )
        .map(item => ({
          id: item.name.replace(/^\$/, ''),
          label: item.name.startsWith('$') ? item.name : `$${item.name}`,
          description: typeof item.description === 'string'
            ? item.description.substring(0, 1024)
            : '',
          category: 'skill',
        }));

      debugLog('[DollarCommand] Loaded ' + cachedCommands.length + ' commands');
    } catch (error) {
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

  if (!query) return cachedCommands;

  const lowerQuery = query.toLowerCase();
  return cachedCommands.filter(
    cmd =>
      cmd.label.toLowerCase().includes(lowerQuery) ||
      cmd.description?.toLowerCase().includes(lowerQuery)
  );
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
