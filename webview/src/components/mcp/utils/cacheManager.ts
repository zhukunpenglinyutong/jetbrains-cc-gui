/**
 * MCP Cache Management Module
 * Provides caching for server lists, statuses, and tool lists
 */

import type { CachedData, ToolsCacheData, CacheKeys, McpTool } from '../types';

// ============================================================================
// Cache Configuration
// ============================================================================

/** Cache expiry durations (server list: 10min, status: 5min, tool list: 10min) */
export const CACHE_EXPIRY = {
  SERVERS: 10 * 60 * 1000,
  STATUS: 5 * 60 * 1000,
  TOOLS: 10 * 60 * 1000,
};

/** Maximum size per cache item (in bytes); items exceeding this are not cached */
const MAX_CACHE_ITEM_SIZE = 512 * 1024; // 512KB

/** Maximum number of servers in the tools cache */
const MAX_CACHED_SERVERS = 50;

// ============================================================================
// Cache Key Generation
// ============================================================================

/**
 * Get provider-specific cache keys
 * @param provider - Provider type
 * @returns Set of cache keys
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
// General Cache Operations
// ============================================================================

/**
 * Get cache expiry duration for a given key
 * @param key - Cache key
 * @param cacheKeys - Set of cache keys
 * @returns Expiry duration in milliseconds
 */
export function getCacheExpiry(key: string, cacheKeys: CacheKeys): number {
  if (key === cacheKeys.SERVERS) return CACHE_EXPIRY.SERVERS;
  if (key === cacheKeys.STATUS) return CACHE_EXPIRY.STATUS;
  if (key === cacheKeys.TOOLS) return CACHE_EXPIRY.TOOLS;
  return 5 * 60 * 1000; // Default: 5 minutes
}

/**
 * Read from cache (supports varying expiry durations)
 * @param key - Cache key
 * @param cacheKeys - Set of cache keys
 * @returns Cached data or null
 */
export function readCache<T>(key: string, cacheKeys: CacheKeys): T | null {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    const parsed: CachedData<T> = JSON.parse(cached);
    // Check if the cache has expired
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
 * Write data to cache
 * @param key - Cache key
 * @param data - Data to cache
 */
export function writeCache<T>(key: string, data: T): void {
  try {
    const cached: CachedData<T> = {
      data,
      timestamp: Date.now(),
    };
    const jsonStr = JSON.stringify(cached);
    // Check cache size limit
    if (jsonStr.length > MAX_CACHE_ITEM_SIZE) {
      console.warn('[MCP] Cache item too large, skipping:', key, `(${Math.round(jsonStr.length / 1024)}KB)`);
      return;
    }
    localStorage.setItem(key, jsonStr);
  } catch (e) {
    // Handle localStorage quota exceeded error
    if (e instanceof Error && e.name === 'QuotaExceededError') {
      console.warn('[MCP] localStorage quota exceeded, clearing old caches');
      // Attempt to clear old MCP-related caches
      clearMcpCaches();
    } else {
      console.warn('[MCP] Failed to write cache:', e);
    }
  }
}

/**
 * Clear all MCP-related caches (used when quota is exceeded)
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
// Tool List Cache Operations
// ============================================================================

/**
 * Read the tools cache for a single server
 * @param serverId - Server ID
 * @param cacheKeys - Set of cache keys
 * @returns Tool list or null
 */
export function readToolsCache(serverId: string, cacheKeys: CacheKeys): McpTool[] | null {
  try {
    const cached = localStorage.getItem(cacheKeys.TOOLS);
    if (!cached) return null;
    const parsed: ToolsCacheData = JSON.parse(cached);
    const serverCache = parsed[serverId];
    if (!serverCache) return null;
    // Check if the cache has expired
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
 * Write the tools cache for a single server
 * @param serverId - Server ID
 * @param tools - Tool list
 * @param cacheKeys - Set of cache keys
 */
export function writeToolsCache(serverId: string, tools: McpTool[], cacheKeys: CacheKeys): void {
  try {
    const cachedStr = localStorage.getItem(cacheKeys.TOOLS);
    const parsed: ToolsCacheData = cachedStr ? JSON.parse(cachedStr) : {};

    // Enforce server count limit using LRU eviction strategy
    const serverIds = Object.keys(parsed);
    if (serverIds.length >= MAX_CACHED_SERVERS && !parsed[serverId]) {
      // Find and remove the oldest cache entry
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
    // Check total size limit
    if (jsonStr.length > MAX_CACHE_ITEM_SIZE * 2) {
      console.warn('[MCP] Tools cache too large, clearing oldest entries');
      // Evict the oldest half of entries
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
 * Clear the tools cache for a single server
 * @param serverId - Server ID
 * @param cacheKeys - Set of cache keys
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
 * Clear all tools cache
 * @param cacheKeys - Set of cache keys
 */
export function clearAllToolsCache(cacheKeys: CacheKeys): void {
  try {
    localStorage.removeItem(cacheKeys.TOOLS);
  } catch (e) {
    console.warn('[MCP] Failed to clear all tools cache:', e);
  }
}
