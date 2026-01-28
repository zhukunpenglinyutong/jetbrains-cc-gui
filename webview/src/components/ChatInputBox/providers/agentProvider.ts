import type { DropdownItemData } from '../types';
import type { AgentConfig } from '../../../types/agent';
import { sendBridgeEvent } from '../../../utils/bridge';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface AgentItem {
  id: string;
  name: string;
  prompt?: string;
}

// ============================================================================
// 状态管理
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedAgents: AgentItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 3000; // 减少到3秒，更快的超时反馈
const MAX_RETRY_COUNT = 2; // 最多重试2次，避免无限循环

// ============================================================================
// 核心函数
// ============================================================================

export function resetAgentsState() {
  cachedAgents = [];
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Agents state reset')));
  pendingWaiters = [];
  debugLog('[AgentProvider] State reset');
}

export function setupAgentsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateAgents) return;

  const handler = (json: string) => {
    debugLog('[AgentProvider] Received data from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      let agents: AgentItem[] = [];

      if (Array.isArray(parsed)) {
        agents = parsed.map((agent: AgentConfig) => ({
          id: agent.id,
          name: agent.name,
          prompt: agent.prompt,
        }));
      }

      cachedAgents = agents;
      loadingState = 'success';
      retryCount = 0; // 成功后重置重试计数
      pendingWaiters.forEach(w => w.resolve());
      pendingWaiters = [];
      debugLog('[AgentProvider] Successfully loaded ' + agents.length + ' agents');
    } catch (error) {
      loadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[AgentProvider] Failed to parse agents:', error);
    }
  };

  // 保存原有的回调
  const originalHandler = window.updateAgents;

  window.updateAgents = (json: string) => {
    // 调用我们的处理器
    handler(json);
    // 也调用原有的处理器（如果存在）
    originalHandler?.(json);
  };

  callbackRegistered = true;
  debugLog('[AgentProvider] Callback registered');
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
      reject(new Error('Agents loading timeout'));
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
    debugLog('[AgentProvider] Skipping refresh (too soon)');
    return false;
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[AgentProvider] Max retry count reached, giving up');
    loadingState = 'failed';
    return false;
  }

  const attempt = retryCount + 1;
  const sent = sendBridgeEvent('get_agents');
  if (!sent) {
    debugLog('[AgentProvider] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  loadingState = 'loading';
  retryCount = attempt;

  debugLog('[AgentProvider] Requesting refresh from backend (attempt ' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

function filterAgents(agents: AgentItem[], query: string): AgentItem[] {
  if (!query) return agents;

  const lowerQuery = query.toLowerCase();
  return agents.filter(agent =>
    agent.name.toLowerCase().includes(lowerQuery) ||
    agent.prompt?.toLowerCase().includes(lowerQuery)
  );
}

export const CREATE_NEW_AGENT_ID = '__create_new__';
export const EMPTY_STATE_ID = '__empty_state__';

export async function agentProvider(
  query: string,
  signal: AbortSignal
): Promise<AgentItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupAgentsCallback();

  const now = Date.now();
  
  // 创建智能体项
  const createNewAgentItem: AgentItem = {
    id: CREATE_NEW_AGENT_ID,
    name: i18n.t('settings.agent.createAgent'),
    prompt: '',
  };

  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[AgentProvider] Loading timeout');
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
      prompt: '',
    }, createNewAgentItem];
  }

  const filtered = cachedAgents.length > 0 ? filterAgents(cachedAgents, query) : [];

  if (filtered.length === 0) {
    return [{
      id: EMPTY_STATE_ID,
      name: i18n.t('settings.agent.noAgentsDropdown'),
      prompt: '',
    }, createNewAgentItem];
  }

  return [...filtered, createNewAgentItem];
}

export function agentToDropdownItem(agent: AgentItem): DropdownItemData {
  // 特殊处理加载中和空状态
  if (agent.id === '__loading__' || agent.id === '__empty__' || agent.id === EMPTY_STATE_ID) {
    return {
      id: agent.id,
      label: agent.name,
      description: agent.prompt,
      icon: agent.id === EMPTY_STATE_ID ? 'codicon-info' : 'codicon-robot',
      type: 'info',
      data: { agent },
    };
  }
  
  // 特殊处理创建智能体
  if (agent.id === CREATE_NEW_AGENT_ID) {
    return {
      id: agent.id,
      label: agent.name,
      description: i18n.t('settings.agent.createAgentHint'),
      icon: 'codicon-add',
      type: 'agent',
      data: { agent },
    };
  }

  return {
    id: agent.id,
    label: agent.name,
    description: agent.prompt ?
      (agent.prompt.length > 60 ? agent.prompt.substring(0, 60) + '...' : agent.prompt) :
      undefined,
    icon: 'codicon-robot',
    type: 'agent',
    data: { agent },
  };
}

export function forceRefreshAgents(): void {
  debugLog('[AgentProvider] Force refresh requested');
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0; // 重置重试计数
  pendingWaiters.forEach(w => w.reject(new Error('Agents refresh requested')));
  pendingWaiters = [];
  requestRefresh();
}

export default agentProvider;
