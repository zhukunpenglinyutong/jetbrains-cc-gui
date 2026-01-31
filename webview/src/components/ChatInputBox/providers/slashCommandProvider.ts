import type { CommandItem, DropdownItemData } from '../types';
import { sendBridgeEvent } from '../../../utils/bridge';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

/**
 * 本地命令列表（需要被过滤掉的命令）
 */
const HIDDEN_COMMANDS = new Set([
  '/context',
  '/cost',
  '/pr-comments',
  '/release-notes',
  '/security-review',
  '/todo',
]);

/**
 * 本地新建会话命令（/clear, /new, /reset 是同一个命令的别名）
 * 这些命令在前端直接处理，不需要发送到 SDK
 */
const NEW_SESSION_COMMAND_ALIASES = new Set(['/clear', '/new', '/reset']);

function getLocalNewSessionCommands(): CommandItem[] {
  return [{
    id: 'clear',
    label: '/clear',
    description: i18n.t('chat.clearCommandDescription'),
    category: 'system',
  }];
}

// ============================================================================
// 状态管理
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedSdkCommands: CommandItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 8000;
const MAX_RETRY_COUNT = 3;

// ============================================================================
// 核心函数
// ============================================================================

export function resetSlashCommandsState() {
  cachedSdkCommands = [];
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Slash commands state reset')));
  pendingWaiters = [];
  debugLog('[SlashCommand] State reset');
}

interface SDKSlashCommand {
  name: string;
  description?: string;
}

export function setupSlashCommandsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateSlashCommands) return;

  const handler = (json: string) => {
    debugLog('[SlashCommand] Received data from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      let commands: CommandItem[] = [];

      if (Array.isArray(parsed)) {
        if (parsed.length > 0) {
          if (typeof parsed[0] === 'object' && parsed[0] !== null && 'name' in parsed[0]) {
            const sdkCommands: SDKSlashCommand[] = parsed;
            commands = sdkCommands.map(cmd => ({
              id: cmd.name.replace(/^\//, ''),
              label: cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`,
              description: cmd.description || '',
              category: getCategoryFromCommand(cmd.name),
            }));
          } else if (typeof parsed[0] === 'string') {
            const commandNames: string[] = parsed;
            commands = commandNames.map(name => ({
              id: name.replace(/^\//, ''),
              label: name.startsWith('/') ? name : `/${name}`,
              description: '',
              category: getCategoryFromCommand(name),
            }));
          }
        }

        cachedSdkCommands = commands;
        loadingState = 'success';
        retryCount = 0;
        pendingWaiters.forEach(w => w.resolve());
        pendingWaiters = [];
        debugLog('[SlashCommand] Successfully loaded ' + commands.length + ' commands');
      } else {
        loadingState = 'failed';
        const error = new Error('Slash commands payload is not an array');
        pendingWaiters.forEach(w => w.reject(error));
        pendingWaiters = [];
        debugWarn('[SlashCommand] Invalid commands payload');
      }
    } catch (error) {
      loadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[SlashCommand] Failed to parse commands:', error);
    }
  };

  const originalHandler = window.updateSlashCommands;

  window.updateSlashCommands = (json: string) => {
    handler(json);
    originalHandler?.(json);
  };
  callbackRegistered = true;
  debugLog('[SlashCommand] Callback registered');

  if (window.__pendingSlashCommands) {
    debugLog('[SlashCommand] Processing pending commands');
    const pending = window.__pendingSlashCommands;
    window.__pendingSlashCommands = undefined;
    handler(pending);
  }
}

function waitForSlashCommands(signal: AbortSignal, timeoutMs: number): Promise<void> {
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
      reject(new Error('Slash commands loading timeout'));
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
    if (loadingState === 'success') {
      waiter.resolve();
    } else if (loadingState === 'failed') {
      waiter.reject(new Error('Slash commands loading failed'));
    }
  });
}

function requestRefresh(): boolean {
  const now = Date.now();

  if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
    debugLog('[SlashCommand] Skipping refresh (too soon)');
    return false;
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[SlashCommand] Max retry count reached');
    loadingState = 'failed';
    return false;
  }

  const attempt = retryCount + 1;
  const sent = sendBridgeEvent('refresh_slash_commands');
  if (!sent) {
    debugLog('[SlashCommand] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  loadingState = 'loading';
  retryCount = attempt;

  debugLog('[SlashCommand] Requesting refresh from backend (attempt ' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

function isHiddenCommand(name: string): boolean {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  if (HIDDEN_COMMANDS.has(normalized)) return true;
  // 隐藏 SDK 返回的 /clear（使用本地版本替代）
  if (NEW_SESSION_COMMAND_ALIASES.has(normalized)) return true;
  const baseName = normalized.split(' ')[0];
  return HIDDEN_COMMANDS.has(baseName) || NEW_SESSION_COMMAND_ALIASES.has(baseName);
}

function getCategoryFromCommand(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('workflow')) return 'workflow';
  if (lowerName.includes('memory') || lowerName.includes('skill')) return 'memory';
  if (lowerName.includes('task')) return 'task';
  if (lowerName.includes('speckit')) return 'speckit';
  if (lowerName.includes('cli')) return 'cli';
  return 'user';
}

function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  const visibleCommands = commands.filter(cmd => !isHiddenCommand(cmd.label));
  const localCommands = getLocalNewSessionCommands();
  const merged = [...localCommands, ...visibleCommands];

  if (!query) return merged;

  const lowerQuery = query.toLowerCase();
  return merged.filter(cmd =>
    cmd.label.toLowerCase().includes(lowerQuery) ||
    cmd.description?.toLowerCase().includes(lowerQuery) ||
    cmd.id.toLowerCase().includes(lowerQuery)
  );
}

export async function slashCommandProvider(
  query: string,
  signal: AbortSignal
): Promise<CommandItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupSlashCommandsCallback();

  const now = Date.now();

  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[SlashCommand] Loading timeout');
    loadingState = 'failed';
    requestRefresh();
  }

  if (loadingState !== 'success') {
    await waitForSlashCommands(signal, LOADING_TIMEOUT).catch(() => {});
  }

  if (loadingState === 'success') {
    return filterCommands(cachedSdkCommands, query);
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    return [{
      id: '__error__',
      label: i18n.t('chat.loadingFailed'),
      description: i18n.t('chat.pleaseCloseAndReopen'),
      category: 'system',
    }];
  }

  return [{
    id: '__loading__',
    label: i18n.t('chat.loadingSlashCommands'),
    description: retryCount > 0 ? i18n.t('chat.retrying', { count: retryCount, max: MAX_RETRY_COUNT }) : i18n.t('chat.pleaseWait'),
    category: 'system',
  }];
}

export function commandToDropdownItem(command: CommandItem): DropdownItemData {
  return {
    id: command.id,
    label: command.label,
    description: command.description,
    icon: 'codicon-terminal',
    type: 'command',
    data: { command },
  };
}

export function forceRefreshSlashCommands(): void {
  debugLog('[SlashCommand] Force refresh requested');
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Slash commands refresh requested')));
  pendingWaiters = [];
  requestRefresh();
}

/**
 * 应用初始化时预加载斜杠命令
 * 在用户输入 "/" 之前就加载命令数据，提升体感性能
 *
 * 安全保证：
 * - 如果已在加载中或已加载完成则跳过（检查 loadingState）
 * - requestRefresh() 有 MIN_REFRESH_INTERVAL 防重复请求保护
 * - 与 slashCommandProvider 共享状态，后续调用可直接命中缓存
 */
export function preloadSlashCommands(): void {
  // 仅在空闲状态下预加载，不干扰正在进行或已完成的加载
  if (loadingState !== 'idle') {
    debugLog('[SlashCommand] Preload skipped (state=' + loadingState + ')');
    return;
  }

  debugLog('[SlashCommand] Preloading commands on app init');

  // 确保回调已注册后再请求刷新
  setupSlashCommandsCallback();

  // 请求刷新 — 内置防重复请求保护
  requestRefresh();
}

export default slashCommandProvider;
