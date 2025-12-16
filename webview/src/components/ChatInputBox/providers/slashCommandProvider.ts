import type { CommandItem, DropdownItemData } from '../types';
import { sendBridgeEvent } from '../../../utils/bridge';

/**
 * 本地命令列表（需要被过滤掉的命令）
 * 这些命令是 Claude Code CLI 的内置命令，不应该在 IDEA 插件中显示
 */
const HIDDEN_COMMANDS = new Set([
  '/clear',        // 清除对话历史并释放上下文
  '/context',      // 以彩色网格方式可视化当前上下文使用情况
  '/cost',         // 显示当前会话的总费用和持续时间
  '/init',         // 使用代码库文档初始化新的 CLAUDE.md 文件
  '/pr-comments',  // 获取 GitHub Pull Request 的评论
  '/release-notes', // 查看发布说明
  '/review',       // 审查 Pull Request
  '/security-review', // 完成当前分支待处理更改的安全审查
  '/todo',         // 列出当前待办事项
]);

/**
 * SDK 斜杠命令缓存
 * 从后端接收的命令列表会存储在这里
 */
let cachedSdkCommands: CommandItem[] = [];
let refreshRequested = false;
let isInitialLoading = true; // 标记是否首次加载
let lastRefreshTime = 0; // 上次刷新请求的时间戳
const REFRESH_TIMEOUT = 5000; // 刷新请求超时时间（5秒）

/**
 * 重置斜杠命令缓存状态
 * 在组件初始化时调用，确保状态是干净的
 */
export function resetSlashCommandsState() {
  cachedSdkCommands = [];
  refreshRequested = false;
  isInitialLoading = true;
  lastRefreshTime = 0;
}

/**
 * SDK 返回的 SlashCommand 类型
 */
interface SDKSlashCommand {
  name: string;
  description?: string;
}

/**
 * 注册 updateSlashCommands 回调，接收从 SDK 获取的命令列表
 */
export function setupSlashCommandsCallback() {
  if (typeof window === 'undefined') return;

  const handler = (json: string) => {
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

      cachedSdkCommands = commands;
      isInitialLoading = false;
      refreshRequested = false;
    } catch (error) {
      // 即使解析失败，也要停止加载状态
      isInitialLoading = false;
      refreshRequested = false;
    }
  };

  window.updateSlashCommands = handler;

  if (window.__pendingSlashCommands) {
    const pending = window.__pendingSlashCommands;
    window.__pendingSlashCommands = undefined;
    handler(pending);
  }

  // 当缓存达到足够规模时，允许后续再次刷新
  if (cachedSdkCommands.length >= 20) {
    refreshRequested = false;
  }
}

/**
 * 检查命令是否应该被隐藏
 */
function isHiddenCommand(name: string): boolean {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  // 检查完整命令名
  if (HIDDEN_COMMANDS.has(normalized)) return true;
  // 检查基础命令名（去掉参数部分）
  const baseName = normalized.split(' ')[0];
  return HIDDEN_COMMANDS.has(baseName);
}

/**
 * 从命令名推断分类
 */
function getCategoryFromCommand(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('workflow')) return 'workflow';
  if (lowerName.includes('memory') || lowerName.includes('skill')) return 'memory';
  if (lowerName.includes('task')) return 'task';
  if (lowerName.includes('speckit')) return 'speckit';
  if (lowerName.includes('cli')) return 'cli';
  return 'user';
}

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

  // 确保回调已设置
  setupSlashCommandsCallback();

  // 检查是否需要重新刷新（超时重试机制）
  const now = Date.now();
  const isRefreshTimedOut = refreshRequested && (now - lastRefreshTime > REFRESH_TIMEOUT);
  if (isRefreshTimedOut) {
    refreshRequested = false;
  }

  // 如果缓存为空且正在首次加载，请求后端刷新
  const shouldRefresh = cachedSdkCommands.length < 20 && !refreshRequested && isInitialLoading;

  if (shouldRefresh) {
    // 通过桥接向后端发送刷新请求
    sendBridgeEvent('refresh_slash_commands');
    refreshRequested = true;
    lastRefreshTime = Date.now();
  }

  // 如果缓存为空且仍在首次加载，返回一个加载提示项
  if (cachedSdkCommands.length === 0 && isInitialLoading) {
    return [{
      id: '__loading__',
      label: '正在加载斜杠指令...',
      description: '首次加载可能需要 1-2 秒',
      category: 'system',
    }];
  }

  // 直接使用缓存的命令列表进行过滤
  return filterCommands(cachedSdkCommands, query);
}

/**
 * 过滤命令
 */
function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  // 先过滤掉隐藏的命令
  const visibleCommands = commands.filter(cmd => !isHiddenCommand(cmd.label));

  if (!query) return visibleCommands;

  const lowerQuery = query.toLowerCase();
  return visibleCommands.filter(cmd =>
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
