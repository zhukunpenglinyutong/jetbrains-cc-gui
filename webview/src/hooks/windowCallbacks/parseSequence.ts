/**
 * Parse a sequence value from the backend (string or number) into a finite number,
 * or null if the value is absent / unparseable.
 */
export const parseSequence = (value: string | number | undefined): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
