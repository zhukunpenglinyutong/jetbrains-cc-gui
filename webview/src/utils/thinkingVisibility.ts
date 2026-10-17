import type { ClaudeContentBlock } from '../types';

/** Native lifecycle placeholders do not provide a readable summary. */
export function shouldRevealThinking(block: ClaudeContentBlock): boolean {
  return block.type !== 'thinking' || block.native !== true || Boolean((block.thinking ?? block.text)?.trim());
}
