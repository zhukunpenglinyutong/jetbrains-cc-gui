import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage, ToolResultBlock } from '../types';

/**
 * Generate a stable key for a message, used for React list keys and anchor navigation.
 * Prefer raw.uuid > __turnId > __renderKey > type-timestamp > content signature fallback.
 */
export function getMessageKey(message: ClaudeMessage, index: number): string {
  const rawObj = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
  if (typeof rawObj?.uuid === 'string') return rawObj.uuid;
  if (message.__turnId !== undefined) {
    return `turn-${message.__turnId}`;
  }
  if (typeof message.__renderKey === 'string' && message.__renderKey.trim().length > 0) {
    return message.__renderKey;
  }
  if (message.timestamp) {
    return `${message.type}-${message.timestamp}`;
  }

  const rawContent = typeof message.raw === 'object'
    ? (message.raw.content ?? message.raw.message?.content)
    : message.raw;
  const signatureSource = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? JSON.stringify(rawContent)
      : message.content ?? '';
  const normalizedSignature = signatureSource
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'empty';

  return `${message.type}-${normalizedSignature}-${index}`;
}

export function findToolResultBlock(
  messages: ClaudeMessage[],
  toolUseId: string | undefined,
  messageIndex: number,
  anchorMessage?: ClaudeMessage,
): ToolResultBlock | null {
  if (!toolUseId || messageIndex < 0) return null;

  const collectToolResults = (message: ClaudeMessage): ToolResultBlock[] => {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') return [];
    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter(
      (block): block is ToolResultBlock =>
        Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
    );
  };

  const resolveAnchorIndex = (): number => {
    if (!anchorMessage) {
      return messageIndex < messages.length ? messageIndex : -1;
    }

    const sourceRange = anchorMessage.__sourceRange;
    if (sourceRange) {
      return sourceRange.start >= 0 && sourceRange.start < messages.length ? sourceRange.start : -1;
    }

    const rawObj = typeof anchorMessage.raw === 'object' ? anchorMessage.raw as Record<string, unknown> : null;
    const anchorUuid = typeof rawObj?.uuid === 'string' ? rawObj.uuid : undefined;
    if (anchorUuid) {
      const byUuid = messages.findIndex((message) => {
        const candidateRaw = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
        return candidateRaw?.uuid === anchorUuid;
      });
      if (byUuid >= 0) return byUuid;
      return -1;
    }

    if (anchorMessage.__turnId !== undefined) {
      const byTurnId = messages.findIndex(
        (message) => message.type === 'assistant' && message.__turnId === anchorMessage.__turnId,
      );
      if (byTurnId >= 0) return byTurnId;
      return -1;
    }

    if (messageIndex < messages.length) {
      const indexedMessage = messages[messageIndex];
      if (indexedMessage === anchorMessage) {
        return messageIndex;
      }

      const indexedRaw = typeof indexedMessage?.raw === 'object' ? indexedMessage.raw as Record<string, unknown> : null;
      const anchorRaw = typeof anchorMessage.raw === 'object' ? anchorMessage.raw as Record<string, unknown> : null;
      if (indexedRaw && anchorRaw && indexedRaw === anchorRaw) {
        return messageIndex;
      }
    }

    return -1;
  };

  const resolveSearchRange = (anchorIndex: number): { start: number; end: number } => {
    const anchor = anchorMessage ?? messages[anchorIndex];
    const anchorTurnId = anchor?.__turnId;

    if (anchorTurnId !== undefined) {
      let start = anchorIndex;
      let end = anchorIndex;
      while (start > 0 && messages[start - 1]?.__turnId === anchorTurnId) {
        start -= 1;
      }
      while (end + 1 < messages.length && messages[end + 1]?.__turnId === anchorTurnId) {
        end += 1;
      }
      return { start, end };
    }

    if (anchor?.__sourceRange) {
      return {
        start: Math.max(0, anchor.__sourceRange.start),
        end: Math.min(messages.length - 1, anchor.__sourceRange.end),
      };
    }

    return { start: anchorIndex, end: anchorIndex };
  };

  const scanToolResultInRange = (
    start: number,
    end: number,
    stopAtAssistantBoundary: boolean,
  ): ToolResultBlock | null => {
    for (let i = start; i <= end; i += 1) {
      const result = collectToolResults(messages[i])[0];
      if (result) return result;
    }

    for (let i = end + 1; i < messages.length; i += 1) {
      const candidate = messages[i];
      if (stopAtAssistantBoundary && candidate?.type === 'assistant') break;
      const result = collectToolResults(candidate)[0];
      if (result) return result;
    }

    for (let i = start - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (stopAtAssistantBoundary && candidate?.type === 'assistant') break;
      const result = collectToolResults(candidate)[0];
      if (result) return result;
    }

    return null;
  };

  const anchorIndex = resolveAnchorIndex();
  if (anchorIndex < 0 || anchorIndex >= messages.length) return null;

  const searchRange = resolveSearchRange(anchorIndex);
  const anchor = anchorMessage ?? messages[anchorIndex];
  return scanToolResultInRange(searchRange.start, searchRange.end, anchor?.__turnId === undefined);
}


/**
 * Extract content from <command-message> and <command-args> tags if present.
 * Returns the combined content: "command-message content command-args content"
 *
 * Example:
 *   Input: "<command-message>aimax:auto</command-message>\n<command-name>/aimax:auto</command-name>\n<command-args>hello there</command-args>"
 *   Output: "aimax:auto hello there"
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
      } else if (type === 'attachment') {
        blocks.push({
          type: 'attachment',
          fileName: typeof candidate.fileName === 'string' ? candidate.fileName : undefined,
          mediaType: typeof candidate.mediaType === 'string' ? candidate.mediaType : undefined,
        });
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
    // Streaming/tool scenario: if raw doesn't have text but message.content has text,
    // append the final assistant text after existing blocks so tool anchoring stays intact.
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

  const getStableId = (message: ClaudeMessage, index: number): string => getMessageKey(message, index);

  const getRenderableBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
    normalizeBlocksFn(message.raw) || [];

  const hasToolResultBlock = (message: ClaudeMessage): boolean => {
    const raw = message.raw;
    if (!raw || typeof raw !== 'object') return false;
    const content = raw.content ?? raw.message?.content;
    return Array.isArray(content) && content.some((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result');
  };

  const hasMeaningfulRenderableBlocks = (message: ClaudeMessage): boolean =>
    getRenderableBlocks(message).some((block) => {
      if (block.type === 'text') {
        return Boolean(block.text && block.text.trim().length > 0);
      }
      if (block.type === 'thinking') {
        const thinkingText = block.thinking ?? block.text ?? '';
        return thinkingText.trim().length > 0;
      }
      return true;
    });

  const hasFallbackMergeAnchor = (message: ClaudeMessage): boolean =>
    getRenderableBlocks(message).some((block) => {
      if (block.type === 'thinking') {
        const thinkingText = block.thinking ?? block.text ?? '';
        return thinkingText.trim().length > 0;
      }
      return block.type === 'tool_use';
    });

  const canMergeAssistantPair = (left: ClaudeMessage, right: ClaudeMessage): boolean => {
    if (left.type !== 'assistant' || right.type !== 'assistant') return false;
    if (left.isStreaming || right.isStreaming) return false;

    if (left.__turnId !== undefined || right.__turnId !== undefined) {
      return left.__turnId !== undefined && right.__turnId !== undefined && left.__turnId === right.__turnId;
    }

    if (hasToolResultBlock(left) || hasToolResultBlock(right)) {
      return false;
    }

    if (!hasFallbackMergeAnchor(left) && !hasFallbackMergeAnchor(right)) {
      return false;
    }

    return hasMeaningfulRenderableBlocks(left) || hasMeaningfulRenderableBlocks(right);
  };

  const buildMergedAssistantMessage = (group: ClaudeMessage[], startIndex: number, endIndex: number): ClaudeMessage => {
    const first = group[0];

    const combinedBlocks: ClaudeContentBlock[] = [];
    const contentParts: string[] = [];

    for (const msg of group) {
      const blocks = getRenderableBlocks(msg);
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

    const mergedContent = contentParts.join('\n');
    const mergedBlocks: ClaudeRawMessage['message'] extends { content?: infer T } ? Exclude<T, string | undefined> : ClaudeContentBlock[] = combinedBlocks.length > 0
      ? combinedBlocks
      : mergedContent
        ? [{ type: 'text' as const, text: mergedContent }]
        : [];

    const nextRaw: ClaudeRawMessage = {
      ...rawBase,
      content: mergedBlocks,
      message: rawBase.message ? { ...rawBase.message, content: mergedBlocks } : { content: mergedBlocks },
    };

    return {
      ...first,
      content: mergedContent,
      raw: nextRaw,
      __turnId: first.__turnId,
      __sourceRange: { start: startIndex, end: endIndex },
      __renderKey: `${getStableId(group[0], startIndex)}..${getStableId(group[group.length - 1], endIndex)}#${group.length}`,
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
    while (
      j < messages.length &&
      canMergeAssistantPair(messages[j - 1], messages[j])
    ) {
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

    const merged = buildMergedAssistantMessage(group, i, j - 1);
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
