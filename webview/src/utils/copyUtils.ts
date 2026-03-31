import type { ClaudeMessage, ClaudeContentBlock, ClaudeRawMessage } from '../types';
import { normalizeBlocks as normalizeBlocksForMessages } from './messageUtils';

/**
 * Normalize raw message blocks to ClaudeContentBlock array
 */
function normalizeBlocks(raw: ClaudeRawMessage | string | undefined): ClaudeContentBlock[] | null {
  return normalizeBlocksForMessages(raw, (text) => text, ((key: string) => key) as any);
}

/**
 * Extract Markdown content from a message for copying
 * @param message - The ClaudeMessage to extract content from
 * @param includeThinking - Whether to include thinking blocks (default: false)
 * @returns The extracted Markdown content as a string
 */
export function extractMarkdownContent(message: ClaudeMessage, includeThinking = false): string {
  const rawBlocks = normalizeBlocks(message.raw);
  const parts: string[] = [];

  if (rawBlocks && rawBlocks.length > 0) {
    for (const block of rawBlocks) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (includeThinking && block.type === 'thinking') {
        const thinkingText = (block as { thinking?: string; text?: string }).thinking ||
                            (block as { thinking?: string; text?: string }).text;
        if (thinkingText) {
          parts.push(`<thinking>\n${thinkingText}\n</thinking>`);
        }
      }
      // tool_use blocks are not included in copy - they contain internal tool calls
    }
  }

  // Fallback to message.content if no text blocks found
  if (parts.length === 0 && message.content && message.content.trim()) {
    parts.push(message.content);
  }

  return parts.join('\n\n');
}

/**
 * Copy text to clipboard with fallback for older browsers
 * @param text - The text to copy
 * @returns Promise<boolean> - Whether the copy was successful
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // Fallback method for environments where navigator.clipboard is not available
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      return successful;
    } catch (e) {
      console.error('Copy failed:', e);
      return false;
    }
  }
}
