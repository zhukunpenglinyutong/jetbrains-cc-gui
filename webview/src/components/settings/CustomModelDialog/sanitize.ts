/**
 * Sanitize user input by stripping control characters and collapsing whitespace.
 * React JSX auto-escapes HTML entities, but this provides defense-in-depth
 * for values persisted to localStorage which may be consumed by non-React code.
 */
export function sanitizeInput(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ');
}
