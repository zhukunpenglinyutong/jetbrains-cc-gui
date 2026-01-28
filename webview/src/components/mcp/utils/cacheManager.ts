/**
 * MCP 缓存管理模块
 * 提供服务器列表、状态和工具列表的缓存管理功能
 */

import type { CachedData, ToolsCacheData, CacheKeys, McpTool } from '../types';

// ============================================================================
// 缓存配置
// ============================================================================

/** 缓存过期时间（服务器列表10分钟，状态5分钟，工具列表10分钟） */
export const CACHE_EXPIRY = {
  SERVERS: 10 * 60 * 1000,
  STATUS: 5 * 60 * 1000,
  TOOLS: 10 * 60 * 1000,
};

/** 单个缓存项最大大小（字节），超过则不缓存 */
const MAX_CACHE_ITEM_SIZE = 512 * 1024; // 512KB

/** 工具缓存最大服务器数量 */
const MAX_CACHED_SERVERS = 50;

// ============================================================================
// 缓存键名生成
// ============================================================================

/**
 * 获取提供商特定的缓存键名
 * @param provider - 提供商类型
 * @returns 缓存键名集合
 */
export function getCacheKeys(provider: 'claude' | 'codex'): CacheKeys {
  return {
    SERVERS: `mcp_servers_cache_${provider}`,
    STATUS: `mcp_status_cache_${provider}`,
    TOOLS: `mcp_tools_cache_${provider}`,
    LAST_SERVER_ID: `mcp_last_server_id_${provider}`,
  };
}

// ============================================================================
// 通用缓存操作
// ============================================================================

/**
 * 获取缓存过期时间
 * @param key - 缓存键名
 * @param cacheKeys - 缓存键名集合
 * @returns 过期时间（毫秒）
 */
export function getCacheExpiry(key: string, cacheKeys: CacheKeys): number {
  if (key === cacheKeys.SERVERS) return CACHE_EXPIRY.SERVERS;
  if (key === cacheKeys.STATUS) return CACHE_EXPIRY.STATUS;
  if (key === cacheKeys.TOOLS) return CACHE_EXPIRY.TOOLS;
  return 5 * 60 * 1000; // 默认5分钟
}

/**
 * 读取缓存（支持不同过期时间）
 * @param key - 缓存键名
 * @param cacheKeys - 缓存键名集合
 * @returns 缓存数据或 null
 */
export function readCache<T>(key: string, cacheKeys: CacheKeys): T | null {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    const parsed: CachedData<T> = JSON.parse(cached);
    // 检查是否过期
    const expiry = getCacheExpiry(key, cacheKeys);
    if (Date.now() - parsed.timestamp > expiry) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * 写入缓存
 * @param key - 缓存键名
 * @param data - 要缓存的数据
 */
export function writeCache<T>(key: string, data: T): void {
  try {
    const cached: CachedData<T> = {
      data,
      timestamp: Date.now(),
    };
    const jsonStr = JSON.stringify(cached);
    // 检查缓存大小限制
    if (jsonStr.length > MAX_CACHE_ITEM_SIZE) {
      console.warn('[MCP] Cache item too large, skipping:', key, `(${Math.round(jsonStr.length / 1024)}KB)`);
      return;
    }
    localStorage.setItem(key, jsonStr);
  } catch (e) {
    // 处理 localStorage 配额超限错误
    if (e instanceof Error && e.name === 'QuotaExceededError') {
      console.warn('[MCP] localStorage quota exceeded, clearing old caches');
      // 尝试清除 MCP 相关的旧缓存
      clearMcpCaches();
    } else {
      console.warn('[MCP] Failed to write cache:', e);
    }
  }
}

/**
 * 清除所有 MCP 相关缓存（用于配额超限时）
 */
function clearMcpCaches(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('mcp_')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
}

// ============================================================================
// 工具列表缓存操作
// ============================================================================

/**
 * 读取单个服务器的工具缓存
 * @param serverId - 服务器 ID
 * @param cacheKeys - 缓存键名集合
 * @returns 工具列表或 null
 */
export function readToolsCache(serverId: string, cacheKeys: CacheKeys): McpTool[] | null {
  try {
    const cached = localStorage.getItem(cacheKeys.TOOLS);
    if (!cached) return null;
    const parsed: ToolsCacheData = JSON.parse(cached);
    const serverCache = parsed[serverId];
    if (!serverCache) return null;
    // 检查是否过期
    if (Date.now() - serverCache.timestamp > CACHE_EXPIRY.TOOLS) {
      delete parsed[serverId];
      localStorage.setItem(cacheKeys.TOOLS, JSON.stringify(parsed));
      return null;
    }
    return serverCache.tools;
  } catch {
    return null;
  }
}

/**
 * 写入单个服务器的工具缓存
 * @param serverId - 服务器 ID
 * @param tools - 工具列表
 * @param cacheKeys - 缓存键名集合
 */
export function writeToolsCache(serverId: string, tools: McpTool[], cacheKeys: CacheKeys): void {
  try {
    const cachedStr = localStorage.getItem(cacheKeys.TOOLS);
    const parsed: ToolsCacheData = cachedStr ? JSON.parse(cachedStr) : {};

    // 检查缓存服务器数量限制，使用 LRU 策略清理
    const serverIds = Object.keys(parsed);
    if (serverIds.length >= MAX_CACHED_SERVERS && !parsed[serverId]) {
      // 找到最旧的缓存并删除
      let oldestId = serverIds[0];
      let oldestTime = parsed[serverIds[0]]?.timestamp ?? Infinity;
      for (const id of serverIds) {
        const timestamp = parsed[id]?.timestamp ?? Infinity;
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestId = id;
        }
      }
      delete parsed[oldestId];
    }

    parsed[serverId] = {
      tools,
      timestamp: Date.now(),
    };

    const jsonStr = JSON.stringify(parsed);
    // 检查总大小限制
    if (jsonStr.length > MAX_CACHE_ITEM_SIZE * 2) {
      console.warn('[MCP] Tools cache too large, clearing oldest entries');
      // 清理一半最旧的条目
      const entries = Object.entries(parsed).sort((a, b) => (a[1]?.timestamp ?? 0) - (b[1]?.timestamp ?? 0));
      const keepCount = Math.floor(entries.length / 2);
      const newParsed: ToolsCacheData = {};
      entries.slice(-keepCount).forEach(([id, data]) => {
        newParsed[id] = data;
      });
      localStorage.setItem(cacheKeys.TOOLS, JSON.stringify(newParsed));
    } else {
      localStorage.setItem(cacheKeys.TOOLS, jsonStr);
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'QuotaExceededError') {
      console.warn('[MCP] localStorage quota exceeded for tools cache');
      clearMcpCaches();
    } else {
      console.warn('[MCP] Failed to write tools cache:', e);
    }
  }
}

/**
 * 清除单个服务器的工具缓存
 * @param serverId - 服务器 ID
 * @param cacheKeys - 缓存键名集合
 */
export function clearToolsCache(serverId: string, cacheKeys: CacheKeys): void {
  try {
    const cachedStr = localStorage.getItem(cacheKeys.TOOLS);
    if (!cachedStr) return;
    const parsed: ToolsCacheData = JSON.parse(cachedStr);
    delete parsed[serverId];
    localStorage.setItem(cacheKeys.TOOLS, JSON.stringify(parsed));
  } catch (e) {
    console.warn('[MCP] Failed to clear tools cache:', e);
  }
}

/**
 * 清除所有工具缓存
 * @param cacheKeys - 缓存键名集合
 */
export function clearAllToolsCache(cacheKeys: CacheKeys): void {
  try {
    localStorage.removeItem(cacheKeys.TOOLS);
  } catch (e) {
    console.warn('[MCP] Failed to clear all tools cache:', e);
  }
}
