/**
 * 工具列表更新 Hook
 * 监听工具列表更新事件并处理状态更新
 */

import { useEffect } from 'react';
import type { ServerToolsState, McpTool, RefreshLog, CacheKeys } from '../types';
import { writeToolsCache } from '../utils';

export interface UseToolsUpdateOptions {
  isCodexMode: boolean;
  cacheKeys: CacheKeys;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
}

/**
 * 工具列表更新 Hook
 * 注册 window.updateMcpServerTools 回调
 */
export function useToolsUpdate({
  isCodexMode,
  cacheKeys,
  setServerTools,
  onLog,
}: UseToolsUpdateOptions): void {
  useEffect(() => {
    if (isCodexMode) {
      // Codex 模式不需要工具列表更新
      return;
    }

    // 注册工具列表更新回调
    const handleToolsUpdate = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        const { serverId, serverName, tools, error } = result;

        if (!serverId) {
          console.warn('[MCP] Tools update missing serverId');
          return;
        }

        if (error) {
          setServerTools(prev => ({
            ...prev,
            [serverId]: {
              tools: prev[serverId]?.tools || [],
              loading: false,
              error: error
            }
          }));
          onLog(
            `获取工具列表失败: ${error}`,
            'error',
            error,
            serverName || serverId
          );
          return;
        }

        const toolList: McpTool[] = tools || [];

        // 更新状态
        setServerTools(prev => ({
          ...prev,
          [serverId]: {
            tools: toolList,
            loading: false,
            error: undefined
          }
        }));

        // 写入缓存
        writeToolsCache(serverId, toolList, cacheKeys);

        onLog(
          `工具列表加载完成: ${toolList.length} 个工具`,
          'success',
          toolList.length > 0 ? `工具: ${toolList.slice(0, 5).map(t => t.name).join(', ')}${toolList.length > 5 ? '...' : ''}` : undefined,
          serverName || serverId
        );
      } catch (e) {
        console.error('[MCP] Failed to parse tools update:', e);
        onLog(
          `解析工具列表失败: ${e}`,
          'error'
        );
      }
    };

    // 注册到 window 对象
    window.updateMcpServerTools = handleToolsUpdate;

    // 清理
    return () => {
      window.updateMcpServerTools = undefined;
    };
  }, [isCodexMode, cacheKeys, setServerTools, onLog]);
}
