/**
 * Generate unique ID (JCEF compatible)
 * Uses crypto.randomUUID when available, falls back to timestamp + random string
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random string
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}
