/**
 * Check whether the specified tool has been denied permission by the user.
 */
export function useIsToolDenied(toolId?: string): boolean {
  return toolId ? window.__deniedToolIds?.has(toolId) ?? false : false;
}
