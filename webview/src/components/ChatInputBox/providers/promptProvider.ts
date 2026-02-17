import type { DropdownItemData } from '../types';
import type { PromptConfig } from '../../../types/prompt';
import { sendBridgeEvent } from '../../../utils/bridge';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface PromptItem {
  id: string;
  name: string;
  content: string;
}

// ============================================================================
// 状态管理
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedPrompts: PromptItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 1500; // 减少到1.5秒，更快的超时反馈
const MAX_RETRY_COUNT = 1; // 最多重试1次，避免长时间等待

// ============================================================================
// 核心函数
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
      retryCount = 0; // 成功后重置重试计数
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

  // 保存原有的回调
  const originalHandler = window.updatePrompts;

  window.updatePrompts = (json: string) => {
    // 调用我们的处理器
    handler(json);
    // 也调用原有的处理器（如果存在）
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

  // 创建提示词项
  const createNewPromptItem: PromptItem = {
    id: CREATE_NEW_PROMPT_ID,
    name: i18n.t('settings.prompt.createPrompt'),
    content: '',
  };

  // 如果已经有缓存数据，直接使用缓存
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

  // 尝试刷新数据（非阻塞）
  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[PromptProvider] Loading timeout');
    loadingState = 'failed';
  }

  // 只等待很短时间（500ms），然后返回当前可用数据
  if (loadingState === 'loading') {
    await waitForPrompts(signal, 500).catch(() => {});
  }

  // 无论加载状态如何，都返回结果
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

  // 没有数据时，直接显示空状态和创建按钮
  return [{
    id: EMPTY_STATE_ID,
    name: i18n.t('settings.prompt.noPromptsDropdown'),
    content: '',
  }, createNewPromptItem];
}

export function promptToDropdownItem(prompt: PromptItem): DropdownItemData {
  // 特殊处理加载中和空状态
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

  // 特殊处理创建提示词
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
