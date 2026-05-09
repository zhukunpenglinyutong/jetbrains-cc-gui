// Performance optimization constants
/**
 * Maximum number of merged message groups to cache before clearing.
 * This prevents unbounded memory growth while maintaining cache benefits.
 */
export const MESSAGE_MERGE_CACHE_LIMIT = 3000;
