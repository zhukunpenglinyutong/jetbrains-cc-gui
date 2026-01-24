import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage } from '../types';

/**
 * Extract content from <command-message> and <command-args> tags if present.
 * Returns the combined content: "command-message content command-args content"
 *
 * Example:
 *   Input: "<command-message>aimax:auto</command-message>\n<command-name>/aimax:auto</command-name>\n<command-args>你好啊</command-args>"
 *   Output: "aimax:auto 你好啊"
 */
export function extractCommandMessageContent(text: string): string {
  if (!text) return text;

  const parts: string[] = [];

  // Extract <command-message> content
  const messageMatch = text.match(/<command-message>([\s\S]*?)<\/command-message>/);
  if (messageMatch) {
    const content = messageMatch[1].trim();
    if (content) {
      parts.push(content);
    }
  }

  // Extract <command-args> content
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch) {
    const content = argsMatch[1].trim();
    if (content) {
      parts.push(content);
    }
  }

  // If we found any parts, return them combined
  if (parts.length > 0) {
    return parts.join(' ');
  }

  // No command tags found, return original text
  return text;
}

/**
 * Check if text contains a <command-message> tag
 */
export function hasCommandMessageTag(text: string): boolean {
  if (!text) return false;
  return text.includes('<command-message>') && text.includes('</command-message>');
}

// Performance optimization constants
/**
 * Maximum number of merged message groups to cache before clearing.
 * This prevents unbounded memory growth while maintaining cache benefits.
 */
const MESSAGE_MERGE_CACHE_LIMIT = 3000;

export type LocalizeMessageFn = (text: string) => string;

/**
 * Normalize raw message content into content blocks
 */
export function normalizeBlocks(
  raw: ClaudeRawMessage | string | undefined,
  localizeMessage: LocalizeMessageFn,
  t: TFunction
): ClaudeContentBlock[] | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'string') {
    return [{ type: 'text' as const, text: raw }];
  }

  const buildBlocksFromArray = (entries: unknown[]): ClaudeContentBlock[] => {
    const blocks: ClaudeContentBlock[] = [];
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const candidate = entry as Record<string, unknown>;
      const type = candidate.type as string | undefined;
      if (type === 'text') {
        const rawText = typeof candidate.text === 'string' ? candidate.text : '';
        // Some replies contain placeholder text "(no content)", skip to avoid rendering empty content
        if (rawText.trim() === '(no content)') {
          return;
        }
        blocks.push({
          type: 'text',
          text: localizeMessage(rawText),
        });
      } else if (type === 'thinking') {
        const thinking =
          typeof candidate.thinking === 'string'
            ? (candidate.thinking as string)
            : typeof candidate.text === 'string'
              ? (candidate.text as string)
              : '';
        blocks.push({
          type: 'thinking',
          thinking,
          text: thinking,
        });
      } else if (type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: typeof candidate.id === 'string' ? (candidate.id as string) : undefined,
          name: typeof candidate.name === 'string' ? (candidate.name as string) : t('tools.unknownTool'),
          input: (candidate.input as Record<string, unknown>) ?? {},
        });
      } else if (type === 'image') {
        const source = (candidate as any).source;
        let src: string | undefined;
        let mediaType: string | undefined;

        // Support two formats:
        // 1. Backend/history format: { type: 'image', source: { type: 'base64', media_type: '...', data: '...' } }
        // 2. Frontend direct format: { type: 'image', src: 'data:...', mediaType: '...' }
        if (source && typeof source === 'object') {
          const st = source.type;
          if (st === 'base64' && typeof source.data === 'string') {
            const mt = typeof source.media_type === 'string' ? source.media_type : 'image/png';
            src = `data:${mt};base64,${source.data}`;
            mediaType = mt;
          } else if (st === 'url' && typeof source.url === 'string') {
            src = source.url;
            mediaType = source.media_type;
          }
        } else if (typeof candidate.src === 'string') {
          // Frontend direct format
          src = candidate.src as string;
          mediaType = candidate.mediaType as string | undefined;
        }

        if (src) {
          blocks.push({ type: 'image', src, mediaType });
        }
      }
    });
    return blocks;
  };

  const pickContent = (content: unknown): ClaudeContentBlock[] | null => {
    if (!content) {
      return null;
    }
    if (typeof content === 'string') {
      // If has <command-message>, extract and show content
      if (hasCommandMessageTag(content)) {
        const processedContent = extractCommandMessageContent(content);
        return [{ type: 'text' as const, text: localizeMessage(processedContent) }];
      }

      // Filter empty strings and command messages (without <command-message>)
      if (!content.trim() ||
          content.includes('<command-name>') ||
          content.includes('<local-command-stdout>')) {
        return null;
      }
      return [{ type: 'text' as const, text: localizeMessage(content) }];
    }
    if (Array.isArray(content)) {
      const result = buildBlocksFromArray(content);
      return result.length ? result : null;
    }
    return null;
  };

  const contentBlocks = pickContent(raw.message?.content ?? raw.content);

  // If unable to parse content, try getting from other fields
  if (!contentBlocks) {
    // Try getting from raw.text or other possible fields
    if (typeof raw === 'object') {
      if ('text' in raw && typeof raw.text === 'string' && raw.text.trim()) {
        return [{ type: 'text' as const, text: localizeMessage(raw.text) }];
      }
      // If no content at all, return null instead of showing "(unable to parse content)"
      // This way shouldShowMessage will filter out this message
    }
    return null;
  }

  return contentBlocks;
}

/**
 * Get text content from a message
 */
export function getMessageText(
  message: ClaudeMessage,
  localizeMessage: LocalizeMessageFn,
  t: TFunction
): string {
  let text = '';

  if (message.content) {
    text = message.content;
  } else {
    const raw = message.raw;
    if (!raw) {
      return `(${t('chat.emptyMessage')})`;
    }
    if (typeof raw === 'string') {
      text = raw;
    } else if (typeof raw.content === 'string') {
      text = raw.content;
    } else if (Array.isArray(raw.content)) {
      text = raw.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    } else if (raw.message?.content && Array.isArray(raw.message.content)) {
      text = raw.message.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    } else {
      return `(${t('chat.emptyMessage')})`;
    }
  }

  // Apply localization
  let result = localizeMessage(text);

  // Extract <command-message> content if present
  if (hasCommandMessageTag(result)) {
    result = extractCommandMessageContent(result);
  }

  return result;
}

/**
 * Determine if a message should be shown in the UI
 */
export function shouldShowMessage(
  message: ClaudeMessage,
  getMessageTextFn: (msg: ClaudeMessage) => string,
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  t: TFunction
): boolean {
  // Filter isMeta messages (like "Caveat: The messages below were generated...")
  if (message.raw && typeof message.raw === 'object' && 'isMeta' in message.raw && message.raw.isMeta === true) {
    return false;
  }

  // Filter command messages (containing <command-name> or <local-command-stdout> tags)
  // BUT allow <command-message> tags - they will be processed to show only inner content

  // Get raw text content for tag checking (before extraction)
  const getRawTextContent = (): string => {
    if (message.content) return message.content;
    const raw = message.raw;
    if (!raw) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw.content === 'string') return raw.content;
    if (Array.isArray(raw.content)) {
      return raw.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    }
    if (raw.message?.content) {
      if (typeof raw.message.content === 'string') return raw.message.content;
      if (Array.isArray(raw.message.content)) {
        return raw.message.content
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
      }
    }
    return '';
  };

  const rawText = getRawTextContent();

  // If message has <command-message>, allow it to be shown
  // (the content will be extracted by extractCommandMessageContent)
  if (rawText && hasCommandMessageTag(rawText)) {
    // Only filter if it has stdout/stderr output (which should be hidden)
    const hasOutputTags =
      rawText.includes('<local-command-stdout>') ||
      rawText.includes('<local-command-stderr>');
    if (!hasOutputTags) {
      return true;
    }
  }

  // Filter messages with command tags but no <command-message>
  if (rawText && (
    rawText.includes('<command-name>') ||
    rawText.includes('<local-command-stdout>') ||
    rawText.includes('<local-command-stderr>') ||
    rawText.includes('<command-args>')
  )) {
    return false;
  }

  const text = getMessageTextFn(message);
  if (message.type === 'user' && text === '[tool_result]') {
    return false;
  }
  if (message.type === 'assistant') {
    return true;
  }
  if (message.type === 'user' || message.type === 'error') {
    // Check if there's valid text content
    if (text && text.trim() && text !== `(${t('chat.emptyMessage')})` && text !== `(${t('chat.parseError')})`) {
      return true;
    }
    // Check if there are valid content blocks (like images)
    const rawBlocks = normalizeBlocksFn(message.raw);
    if (Array.isArray(rawBlocks) && rawBlocks.length > 0) {
      // Ensure at least one non-empty content block
      const hasValidBlock = rawBlocks.some(block => {
        if (block.type === 'text') {
          return block.text && block.text.trim().length > 0;
        }
        // Images, tool_use and other block types should be shown
        return true;
      });
      return hasValidBlock;
    }
    return false;
  }
  return true;
}

/**
 * Get content blocks from a message for rendering
 */
export function getContentBlocks(
  message: ClaudeMessage,
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  localizeMessage: LocalizeMessageFn
): ClaudeContentBlock[] {
  const rawBlocks = normalizeBlocksFn(message.raw);
  if (rawBlocks && rawBlocks.length > 0) {
    // Streaming/tool scenario: if raw doesn't have text but message.content has text, still need to show text
    const hasTextBlock = rawBlocks.some(
      (block) => block.type === 'text' && typeof (block as any).text === 'string' && String((block as any).text).trim().length > 0,
    );
    if (!hasTextBlock && message.content && message.content.trim()) {
      return [...rawBlocks, { type: 'text', text: localizeMessage(message.content) }];
    }
    return rawBlocks;
  }
  if (message.content && message.content.trim()) {
    return [{ type: 'text', text: localizeMessage(message.content) }];
  }
  // If no content at all, return empty array instead of showing "(empty message)"
  // shouldShowMessage will filter out these messages
  return [];
}

/**
 * Merge consecutive assistant messages to fix style inconsistencies in history
 * where Thinking and ToolUse are separated
 */
export function mergeConsecutiveAssistantMessages(
  messages: ClaudeMessage[],
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  cache?: Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>
): ClaudeMessage[] {
  if (messages.length === 0) return [];

  const getStableId = (message: ClaudeMessage, index: number): string => {
    const rawObj = typeof message.raw === 'object' ? (message.raw as Record<string, unknown> | null) : null;
    const uuid = rawObj?.uuid;
    if (typeof uuid === 'string' && uuid) return uuid;
    if (message.timestamp) return `${message.type}-${message.timestamp}`;
    return `${message.type}-${index}`;
  };

  const buildMergedAssistantMessage = (group: ClaudeMessage[]): ClaudeMessage => {
    const first = group[0];

    const combinedBlocks: ClaudeContentBlock[] = [];
    const contentParts: string[] = [];

    for (const msg of group) {
      const blocks = normalizeBlocksFn(msg.raw) || [];
      if (blocks.length > 0) {
        combinedBlocks.push(...blocks);
      }
      if (msg.content) {
        const trimmed = msg.content.trim();
        if (trimmed) {
          contentParts.push(msg.content);
        }
      }
    }

    const rawBase: ClaudeRawMessage =
      (typeof first.raw === 'object' && first.raw ? { ...(first.raw as ClaudeRawMessage) } : ({} as ClaudeRawMessage));

    const nextRaw: ClaudeRawMessage = {
      ...rawBase,
      content: combinedBlocks,
      message: rawBase.message ? { ...rawBase.message, content: combinedBlocks } : rawBase.message,
    };

    const mergedContent = contentParts.join('\n');

    return {
      ...first,
      content: mergedContent,
      raw: nextRaw,
    };
  };

  const result: ClaudeMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.type !== 'assistant') {
      result.push(msg);
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < messages.length && messages[j].type === 'assistant') {
      j += 1;
    }

    const groupLength = j - i;
    if (groupLength <= 1) {
      result.push(msg);
      i = j;
      continue;
    }

    const group = messages.slice(i, j);
    const groupKey = `${getStableId(group[0], i)}..${getStableId(group[group.length - 1], j - 1)}#${group.length}`;

    if (cache) {
      const cached = cache.get(groupKey);
      if (
        cached &&
        cached.source.length === group.length &&
        cached.source.every((m, idx) => m === group[idx])
      ) {
        result.push(cached.merged);
        i = j;
        continue;
      }
    }

    const merged = buildMergedAssistantMessage(group);
    if (cache) {
      cache.set(groupKey, { source: group, merged });
      if (cache.size > MESSAGE_MERGE_CACHE_LIMIT) {
        cache.clear();
      }
    }
    result.push(merged);
    i = j;
  }

  return result;
}
