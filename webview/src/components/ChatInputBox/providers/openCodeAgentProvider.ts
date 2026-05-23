import { sendBridgeEvent } from '../../../utils/bridge';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';
import { parseOpenCodeAgentPayload } from '../openCodeAgents';
import { EMPTY_STATE_ID, type AgentItem } from './agentProvider';

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedAgents: AgentItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 3000;
const MAX_RETRY_COUNT = 2;

export function resetOpenCodeAgentsState() {
  cachedAgents = [];
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('opencode agents state reset')));
  pendingWaiters = [];
  debugLog('[OpenCodeAgentProvider] State reset');
}

export function setupOpenCodeAgentsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateOpenCodeAgents) return;

  const handler = (json: string) => {
    debugLog('[OpenCodeAgentProvider] Received data from backend, length=' + json.length);

    try {
      cachedAgents = parseOpenCodeAgentPayload(json);
      loadingState = 'success';
      retryCount = 0;
      pendingWaiters.forEach(w => w.resolve());
      pendingWaiters = [];
      debugLog('[OpenCodeAgentProvider] Successfully loaded ' + cachedAgents.length + ' agents');
    } catch (error) {
      loadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[OpenCodeAgentProvider] Failed to parse agents:', error);
    }
  };

  const originalHandler = window.updateOpenCodeAgents;
  window.updateOpenCodeAgents = (json: string) => {
    handler(json);
    originalHandler?.(json);
  };

  callbackRegistered = true;
  debugLog('[OpenCodeAgentProvider] Callback registered');
}

function waitForAgents(signal: AbortSignal, timeoutMs: number): Promise<void> {
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
      reject(new Error('opencode agents loading timeout'));
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

    pendingWaiters.push(waiter);
  });
}

function requestRefresh(): boolean {
  const now = Date.now();

  if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
    debugLog('[OpenCodeAgentProvider] Skipping refresh (too soon)');
    return false;
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[OpenCodeAgentProvider] Max retry count reached, giving up');
    loadingState = 'failed';
    return false;
  }

  const attempt = retryCount + 1;
  const sent = sendBridgeEvent('get_opencode_agents');
  if (!sent) {
    debugLog('[OpenCodeAgentProvider] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  loadingState = 'loading';
  retryCount = attempt;

  debugLog('[OpenCodeAgentProvider] Requesting refresh from backend (attempt ' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

function filterAgents(agents: AgentItem[], query: string): AgentItem[] {
  if (!query) return agents;

  const lowerQuery = query.toLowerCase();
  return agents.filter(agent =>
    agent.name.toLowerCase().includes(lowerQuery) ||
    agent.description?.toLowerCase().includes(lowerQuery) ||
    agent.agentID?.toLowerCase().includes(lowerQuery)
  );
}

export async function openCodeAgentProvider(
  query: string,
  signal: AbortSignal
): Promise<AgentItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupOpenCodeAgentsCallback();

  const now = Date.now();
  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[OpenCodeAgentProvider] Loading timeout');
    loadingState = 'failed';
    requestRefresh();
  }

  if (loadingState !== 'success') {
    await waitForAgents(signal, LOADING_TIMEOUT).catch(() => {});
  }

  if (loadingState !== 'success') {
    return [{
      id: EMPTY_STATE_ID,
      name: retryCount >= MAX_RETRY_COUNT ? i18n.t('settings.agent.loadFailed') : i18n.t('settings.agent.noAgentsDropdown'),
      provider: 'opencode',
    }];
  }

  const filtered = cachedAgents.length > 0 ? filterAgents(cachedAgents, query) : [];
  if (filtered.length === 0) {
    return [{
      id: EMPTY_STATE_ID,
      name: i18n.t('settings.agent.noAgentsDropdown'),
      provider: 'opencode',
    }];
  }

  return filtered;
}
