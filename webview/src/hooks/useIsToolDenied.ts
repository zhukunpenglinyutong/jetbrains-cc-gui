/**
 * 检查指定工具是否被用户拒绝了权限
 */
export function useIsToolDenied(toolId?: string): boolean {
  return toolId ? window.__deniedToolIds?.has(toolId) ?? false : false;
}
