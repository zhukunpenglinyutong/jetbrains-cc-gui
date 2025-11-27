import type { CommandItem, DropdownItemData } from '../types';

// 请求队列管理
let pendingResolve: ((commands: CommandItem[]) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;

/**
 * 注册 Java 回调
 */
function setupCommandListCallback() {
  if (typeof window !== 'undefined' && !window.onCommandListResult) {
    window.onCommandListResult = (json: string) => {
      try {
        const data = JSON.parse(json);
        const commands: CommandItem[] = data.commands || data || [];
        pendingResolve?.(commands);
      } catch (error) {
        console.error('[slashCommandProvider] Parse error:', error);
        pendingReject?.(error as Error);
      } finally {
        pendingResolve = null;
        pendingReject = null;
      }
    };
  }
}

/**
 * 发送请求到 Java
 */
function sendToJava(event: string, payload: Record<string, unknown>) {
  if (window.sendToJava) {
    window.sendToJava(`${event}:${JSON.stringify(payload)}`);
  } else {
    console.warn('[slashCommandProvider] sendToJava not available');
  }
}

/**
 * 默认命令列表（当 Java 端未实现时使用）
 */
const DEFAULT_COMMANDS: CommandItem[] = [
  { id: 'help', label: '/help', description: '显示帮助信息', category: 'general' },
  { id: 'clear', label: '/clear', description: '清空对话历史', category: 'general' },
  { id: 'status', label: '/status', description: '查看会话状态', category: 'general' },
  { id: 'model', label: '/model', description: '切换 AI 模型', category: 'settings' },
  { id: 'mode', label: '/mode', description: '切换对话模式', category: 'settings' },
];

/**
 * 斜杠命令数据提供者
 */
export async function slashCommandProvider(
  query: string,
  signal: AbortSignal
): Promise<CommandItem[]> {
  // 检查是否被取消
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // 设置回调
  setupCommandListCallback();

  return new Promise((resolve, reject) => {
    // 检查是否被取消
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    // 保存回调
    pendingResolve = resolve;
    pendingReject = reject;

    // 监听取消信号
    signal.addEventListener('abort', () => {
      pendingResolve = null;
      pendingReject = null;
      reject(new DOMException('Aborted', 'AbortError'));
    });

    // 检查 sendToJava 是否可用
    if (!window.sendToJava) {
      // 使用默认命令列表进行本地过滤
      const filtered = filterCommands(DEFAULT_COMMANDS, query);
      pendingResolve = null;
      pendingReject = null;
      resolve(filtered);
      return;
    }

    // 发送请求
    sendToJava('get_commands', { query });

    // 超时处理（3秒），超时后使用默认命令
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        pendingReject = null;
        // 超时时返回过滤后的默认命令
        resolve(filterCommands(DEFAULT_COMMANDS, query));
      }
    }, 3000);
  });
}

/**
 * 过滤命令
 */
function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  if (!query) return commands;

  const lowerQuery = query.toLowerCase();
  return commands.filter(cmd =>
    cmd.label.toLowerCase().includes(lowerQuery) ||
    cmd.description?.toLowerCase().includes(lowerQuery) ||
    cmd.id.toLowerCase().includes(lowerQuery)
  );
}

/**
 * 将 CommandItem 转换为 DropdownItemData
 */
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

export default slashCommandProvider;
