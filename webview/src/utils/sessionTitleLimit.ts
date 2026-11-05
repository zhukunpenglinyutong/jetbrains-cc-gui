/**
 * Matches session-titles-service.cjs#updateTitle, which rejects longer titles.
 * The limit counts UTF-16 code units (Node's `.length`), so both the Java
 * belt-and-braces cut and the frontend pre-truncation must use the same unit.
 */
export const CUSTOM_TITLE_MAX_LENGTH = 50;

/**
 * Cuts {@code value} to at most {@code maxUnits} UTF-16 code units, backing off
 * one unit when the cut would split a surrogate pair — half an emoji must never
 * be sent on or persisted into a fork title. Returns '' once maxUnits is spent.
 */
export function truncateToCodeUnits(value: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (value.length <= maxUnits) return value;
  let end = maxUnits;
  const last = value.charCodeAt(end - 1);
  // A high surrogate stranded at the cut means its low surrogate half is dropped;
  // back the cut off so the whole pair goes.
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}
