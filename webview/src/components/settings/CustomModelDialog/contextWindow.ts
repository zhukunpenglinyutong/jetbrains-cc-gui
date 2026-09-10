export const CONTEXT_WINDOW_TOKENS_PER_K = 1_000;
export const MAX_CONTEXT_WINDOW_TOKENS = 2_147_483_647;
export const MAX_CONTEXT_WINDOW_K = Math.floor(MAX_CONTEXT_WINDOW_TOKENS / CONTEXT_WINDOW_TOKENS_PER_K);

export function parseContextWindowKInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const contextWindowK = Number(trimmed);
  return Number.isSafeInteger(contextWindowK)
    ? contextWindowK * CONTEXT_WINDOW_TOKENS_PER_K
    : undefined;
}

export function isInvalidContextWindowValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const contextWindowK = Number(trimmed);
  return !Number.isSafeInteger(contextWindowK)
    || contextWindowK < 1
    || contextWindowK > MAX_CONTEXT_WINDOW_K;
}
