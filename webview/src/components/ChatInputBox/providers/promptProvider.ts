import type { DropdownItemData } from '../types';
import type { PromptConfig } from '../../../types/prompt';
import { sendBridgeEvent } from '../../../utils/bridge';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

// ============================================================================
// Type Definitions
// ============================================================================

export interface PromptItem {
  id: string;
  name: string;
  content: string;
}

// ============================================================================
// State Management
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedPrompts: PromptItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 1500; // Reduced to 1.5s for faster timeout feedback
const MAX_RETRY_COUNT = 1; // Max 1 retry to avoid long waits
const MAX_PENDING_WAITERS = 10; // Maximum concurrent waiters

// ============================================================================
// Core Functions
// ============================================================================

export function resetPromptsState() {
  cachedPrompts = [];
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Prompts state reset')));
  pendingWaiters = [];
  debugLog('[PromptProvider] State reset');
}

export function setupPromptsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updatePrompts) return;

  const handler = (json: string) => {
    debugLog('[PromptProvider] Received data from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      let prompts: PromptItem[] = [];

      if (Array.isArray(parsed)) {
        prompts = parsed.map((prompt: PromptConfig) => ({
          id: prompt.id,
          name: prompt.name,
          content: prompt.content,
        }));
      }

      cachedPrompts = prompts;
      loadingState = 'success';
      retryCount = 0; // Reset retry count on success
      pendingWaiters.forEach(w => w.resolve());
      pendingWaiters = [];
      debugLog('[PromptProvider] Successfully loaded ' + prompts.length + ' prompts');
    } catch (error) {
      loadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[PromptProvider] Failed to parse prompts:', error);
    }
  };

  // Save original callback
  const originalHandler = window.updatePrompts;

  window.updatePrompts = (json: string) => {
    // Call our handler
    handler(json);
    // Also call original handler (if exists)
    originalHandler?.(json);
  };

  callbackRegistered = true;
  debugLog('[PromptProvider] Callback registered');
}

function waitForPrompts(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (loadingState === 'success') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const waiter = { resolve: () => {}, reject: (_error: unknown) => {} } as {
      resolve: () => void;
      reject: (error: unknown) => void;
    };

    const cleanup = () => {
      pendingWaiters = pendingWaiters.filter(w => w !== waiter);
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Prompts loading timeout'));
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });

    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error: unknown) => {
      cleanup();
      reject(error);
    };

    // Evict oldest waiters if limit exceeded
    if (pendingWaiters.length >= MAX_PENDING_WAITERS) {
      const evicted = pendingWaiters.splice(0, pendingWaiters.length - MAX_PENDING_WAITERS + 1);
      evicted.forEach(w => w.reject(new Error('Too many pending waiters')));
    }

    pendingWaiters.push(waiter);
  });
}

function requestRefresh(): boolean {
  const now = Date.now();

  if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
    debugLog('[PromptProvider] Skipping refresh (too soon)');
    return false;
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[PromptProvider] Max retry count reached, giving up');
    loadingState = 'failed';
    return false;
  }

  const attempt = retryCount + 1;
  const sent = sendBridgeEvent('get_prompts');
  if (!sent) {
    debugLog('[PromptProvider] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  loadingState = 'loading';
  retryCount = attempt;

  debugLog('[PromptProvider] Requesting refresh from backend (attempt ' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

function filterPrompts(prompts: PromptItem[], query: string): PromptItem[] {
  if (!query) return prompts;

  const lowerQuery = query.toLowerCase();
  return prompts.filter(prompt =>
    prompt.name.toLowerCase().includes(lowerQuery) ||
    prompt.content.toLowerCase().includes(lowerQuery)
  );
}

export const CREATE_NEW_PROMPT_ID = '__create_new__';
export const EMPTY_STATE_ID = '__empty_state__';

export async function promptProvider(
  query: string,
  signal: AbortSignal
): Promise<PromptItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupPromptsCallback();

  const now = Date.now();

  // Create prompt item
  const createNewPromptItem: PromptItem = {
    id: CREATE_NEW_PROMPT_ID,
    name: i18n.t('settings.prompt.createPrompt'),
    content: '',
  };

  // If cached data exists, use cache directly
  if (loadingState === 'success' && cachedPrompts.length > 0) {
    const filtered = filterPrompts(cachedPrompts, query);
    if (filtered.length === 0) {
      return [{
        id: EMPTY_STATE_ID,
        name: i18n.t('settings.prompt.noPromptsDropdown'),
        content: '',
      }, createNewPromptItem];
    }
    return [...filtered, createNewPromptItem];
  }

  // Attempt to refresh data (non-blocking)
  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[PromptProvider] Loading timeout');
    loadingState = 'failed';
  }

  // Wait only briefly (500ms), then return currently available data
  if (loadingState === 'loading') {
    await waitForPrompts(signal, 500).catch(() => {});
  }

  // Return results regardless of loading state
  if (loadingState === 'success' && cachedPrompts.length > 0) {
    const filtered = filterPrompts(cachedPrompts, query);
    if (filtered.length === 0) {
      return [{
        id: EMPTY_STATE_ID,
        name: i18n.t('settings.prompt.noPromptsDropdown'),
        content: '',
      }, createNewPromptItem];
    }
    return [...filtered, createNewPromptItem];
  }

  // When no data available, show empty state and create button
  return [{
    id: EMPTY_STATE_ID,
    name: i18n.t('settings.prompt.noPromptsDropdown'),
    content: '',
  }, createNewPromptItem];
}

export function promptToDropdownItem(prompt: PromptItem): DropdownItemData {
  // Special handling for loading and empty states
  if (prompt.id === '__loading__' || prompt.id === '__empty__' || prompt.id === EMPTY_STATE_ID) {
    return {
      id: prompt.id,
      label: prompt.name,
      description: prompt.content,
      icon: prompt.id === EMPTY_STATE_ID ? 'codicon-info' : 'codicon-bookmark',
      type: 'info',
      data: { prompt },
    };
  }

  // Special handling for create prompt item
  if (prompt.id === CREATE_NEW_PROMPT_ID) {
    return {
      id: prompt.id,
      label: prompt.name,
      description: i18n.t('settings.prompt.createPromptHint'),
      icon: 'codicon-add',
      type: 'prompt',
      data: { prompt },
    };
  }

  return {
    id: prompt.id,
    label: prompt.name,
    description: prompt.content ?
      (prompt.content.length > 60 ? prompt.content.substring(0, 60) + '...' : prompt.content) :
      undefined,
    icon: 'codicon-bookmark',
    type: 'prompt',
    data: { prompt },
  };
}

export default promptProvider;
