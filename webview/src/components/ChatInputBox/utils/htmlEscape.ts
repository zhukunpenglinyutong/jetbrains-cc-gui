/**
 * Escape HTML attribute values
 * Ensures special characters (quotes, <, >, &, etc.) are properly escaped.
 * Note: Backslashes don't need escaping as they are valid in HTML attributes.
 */
export function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
