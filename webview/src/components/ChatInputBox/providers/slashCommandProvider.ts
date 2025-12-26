import type { CommandItem, DropdownItemData } from '../types';
import { sendBridgeEvent } from '../../../utils/bridge';

/**
 * 本地命令列表（需要被过滤掉的命令）
 */
const HIDDEN_COMMANDS = new Set([
  '/clear',
  '/context',
  '/cost',
  '/init',
  '/pr-comments',
  '/release-notes',
  '/review',
  '/security-review',
  '/todo',
]);

// ============================================================================
// 状态管理
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedSdkCommands: CommandItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;

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
  console.log('[SlashCommand] State reset');
}

interface SDKSlashCommand {
  name: string;
  description?: string;
}

export function setupSlashCommandsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateSlashCommands) return;

  const handler = (json: string) => {
    console.log('[SlashCommand] Received data from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      let commands: CommandItem[] = [];

      if (Array.isArray(parsed) && parsed.length > 0) {
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

      if (commands.length > 0) {
        cachedSdkCommands = commands;
        loadingState = 'success';
        retryCount = 0;
        console.log('[SlashCommand] Successfully loaded ' + commands.length + ' commands');
      } else {
        loadingState = 'failed';
        console.warn('[SlashCommand] Received empty commands');
      }
    } catch (error) {
      loadingState = 'failed';
      console.error('[SlashCommand] Failed to parse commands:', error);
    }
  };

  window.updateSlashCommands = handler;
  callbackRegistered = true;
  console.log('[SlashCommand] Callback registered');

  if (window.__pendingSlashCommands) {
    console.log('[SlashCommand] Processing pending commands');
    const pending = window.__pendingSlashCommands;
    window.__pendingSlashCommands = undefined;
    handler(pending);
  }
}

function requestRefresh(): void {
  const now = Date.now();

  if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
    console.log('[SlashCommand] Skipping refresh (too soon)');
    return;
  }

  if (loadingState === 'failed' && retryCount >= MAX_RETRY_COUNT) {
    console.warn('[SlashCommand] Max retry count reached');
    return;
  }

  if (loadingState === 'failed') {
    retryCount++;
    console.log('[SlashCommand] Retry #' + retryCount);
  }

  lastRefreshTime = now;
  loadingState = 'loading';

  console.log('[SlashCommand] Requesting refresh from backend');
  sendBridgeEvent('refresh_slash_commands');
}

function isHiddenCommand(name: string): boolean {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  if (HIDDEN_COMMANDS.has(normalized)) return true;
  const baseName = normalized.split(' ')[0];
  return HIDDEN_COMMANDS.has(baseName);
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

  if (!query) return visibleCommands;

  const lowerQuery = query.toLowerCase();
  return visibleCommands.filter(cmd =>
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

  switch (loadingState) {
    case 'idle':
      requestRefresh();
      return [{
        id: '__loading__',
        label: '正在加载斜杠指令...',
        description: '首次加载可能需要几秒钟',
        category: 'system',
      }];

    case 'loading':
      if (now - lastRefreshTime > LOADING_TIMEOUT) {
        console.warn('[SlashCommand] Loading timeout, marking as failed');
        loadingState = 'failed';
        requestRefresh();
      }
      return [{
        id: '__loading__',
        label: '正在加载斜杠指令...',
        description: retryCount > 0 ? `正在重试 (${retryCount}/${MAX_RETRY_COUNT})...` : '请稍候...',
        category: 'system',
      }];

    case 'failed':
      if (retryCount < MAX_RETRY_COUNT) {
        requestRefresh();
        return [{
          id: '__loading__',
          label: '正在重新加载...',
          description: `正在重试 (${retryCount + 1}/${MAX_RETRY_COUNT})...`,
          category: 'system',
        }];
      }
      return [{
        id: '__error__',
        label: '加载失败',
        description: '请关闭并重新打开窗口',
        category: 'system',
      }];

    case 'success':
      if (cachedSdkCommands.length > 0) {
        return filterCommands(cachedSdkCommands, query);
      }
      loadingState = 'idle';
      return slashCommandProvider(query, signal);
  }
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
  console.log('[SlashCommand] Force refresh requested');
  retryCount = 0;
  loadingState = 'idle';
  lastRefreshTime = 0;
  requestRefresh();
}

export default slashCommandProvider;
