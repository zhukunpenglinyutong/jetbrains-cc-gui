import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage } from '../types';

/**
 * Generate a stable key for a message, used for React list keys and anchor navigation.
 * Prefer raw.uuid > __turnId > type-timestamp > fallback to type-index.
 */
export function getMessageKey(message: ClaudeMessage, index: number): string {
  const rawObj = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
  if (rawObj?.uuid) return rawObj.uuid as string;
  if (message.__turnId !== undefined) return `turn-${message.__turnId}`;
  return message.timestamp ? `${message.type}-${message.timestamp}` : `${message.type}-${index}`;
}

/**
 * Extract content from <command-message> and <command-args> tags if present.
 * Returns the combined content: "command-message content command-args content"
 *
 * @deprecated Use {@link formatCommandForDisplay} instead. Kept as fallback only.
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

// ---------------------------------------------------------------------------
// Constants - avoid magic strings throughout the codebase
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = {
  USER: 'user',
  ASSISTANT: 'assistant',
  TASK_NOTIFICATION: 'task_notification',
  NOTIFICATION: 'notification',
  ERROR: 'error',
} as const;

export const ORIGIN_KINDS = {
  HUMAN: 'human',
  TASK_NOTIFICATION: 'task-notification',
  HOOK: 'hook',
  AGENT: 'agent',
  QUEUE: 'queue',
  CHANNEL: 'channel',
} as const;

// ---------------------------------------------------------------------------
// Optimized regex patterns - single pattern instead of multiple matches
// NOTE: These regexes assume SDK outputs tags in a fixed order
// (command-message → command-name → command-args → skill-format).
// If SDK changes tag order, these must be updated.
// ---------------------------------------------------------------------------

// Regex to extract command-message and related tags (supports multiline content)
const COMMAND_TAGS_REGEX = /<command-message>([\s\S]*?)<\/command-message>(?:[\s\n]*<command-name>([\s\S]*?)<\/command-name>)?(?:[\s\n]*<command-args>([\s\S]*?)<\/command-args>)?(?:[\s\n]*<skill-format>([\s\S]*?)<\/skill-format>)?/;

// Regex for resubmit format - only needs command-name and command-args (no command-message required)
const COMMAND_NAME_REGEX = /<command-name>([\s\S]*?)<\/command-name>(?:[\s\n]*<command-args>([\s\S]*?)<\/command-args>)?/;

// Regex to extract task-notification tags (supports multiline content)
// Actual SDK format: <task-notification><task-id>...<status>...<summary>...<result>...<usage>...</task-notification>
// We only need status and summary, so match them regardless of position
// Two regexes: one for full format (with status), one for minimal format (only summary)
const TASK_NOTIFICATION_REGEX_WITH_STATUS = /<task-notification>[\s\S]*?<status>([\s\S]*?)<\/status>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/task-notification>/;
const TASK_NOTIFICATION_REGEX_NO_STATUS = /<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/task-notification>/;

// ---------------------------------------------------------------------------
// Internal XML tags that should be hidden (not rendered as user messages)
// ---------------------------------------------------------------------------

/** Tags that represent hidden terminal output */
export const HIDDEN_OUTPUT_TAGS = ['<local-command-stdout>', '<local-command-stderr>'] as const;

/** Tags that represent internal command metadata (no <command-message>) */
export const INTERNAL_METADATA_TAGS = ['<command-name>', '<command-args>', '<skill-format>', '<local-command-caveat>'] as const;

/** All tags that should be filtered out in normalizeBlocks text entries.
 *  Composed from INTERNAL_METADATA_TAGS + HIDDEN_OUTPUT_TAGS to stay in sync. */
export const FILTERED_NORMALIZE_TAGS = [...INTERNAL_METADATA_TAGS, ...HIDDEN_OUTPUT_TAGS] as const;

/** Check if text contains any tag from the given array */
export function containsAnyTag(text: string, tags: readonly string[]): boolean {
  return tags.some(tag => text.includes(tag));
}

/**
 * Check if text contains a <command-message> tag
 */
export function hasCommandMessageTag(text: string): boolean {
  if (!text) return false;
  return text.includes('<command-message>') && text.includes('</command-message>');
}

/**
 * Format command message for display, matching CLI's UserCommandMessage behavior.
 * - If <skill-format>true</skill-format>: return "Skill(name)"
 * - Otherwise: return "/name args" (prepend / to command-message)
 *
 * @param text - Raw text containing XML tags
 * @returns Formatted display string, or null if no command-message tag
 */
export function formatCommandForDisplay(text: string): string | null {
  if (!text) return null;

  // Single regex match extracts all tags at once (performance optimization)
  const match = COMMAND_TAGS_REGEX.exec(text);
  if (!match?.[1]) return null;

  const commandMessage = match[1].trim();
  if (!commandMessage) return null;

  const args = match[3]?.trim() ?? '';
  const isSkillFormat = match[4]?.trim() === 'true';

  if (isSkillFormat) {
    // Skill loading message: "Skill(name)"
    // CLI's UserCommandMessage ignores args in skill-format mode
    return `Skill(${commandMessage})`;
  }

  // Slash command format: "/name args" (no prefix symbol for GUI)
  return args ? `/${commandMessage} ${args}` : `/${commandMessage}`;
}

/**
 * Format command message for copy/resubmit, matching CLI's textForResubmit behavior.
 * Uses <command-name> tag which already contains the / prefix.
 *
 * @param text - Raw text containing XML tags
 * @returns Formatted resubmit string, or null if no command-name tag
 */
export function formatCommandForResubmit(text: string): string | null {
  if (!text) return null;

  // Use dedicated regex that matches command-name without requiring command-message
  const match = COMMAND_NAME_REGEX.exec(text);
  if (!match?.[1]) return null;

  const commandName = match[1].trim();
  if (!commandName) return null;

  const args = match[2]?.trim() ?? '';
  return args ? `${commandName} ${args}` : commandName;
}

/**
 * Check if text contains a <task-notification> tag
 */
export function hasTaskNotificationTag(text: string): boolean {
  if (!text) return false;
  return text.includes('<task-notification>');
}

// ---------------------------------------------------------------------------
// Type guards - safer than type assertions
// ---------------------------------------------------------------------------

/**
 * Type guard: check if raw message has valid origin field
 */
function hasOriginField(raw: unknown): raw is { origin: { kind: string } } {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const origin = r.origin;
  if (!origin || typeof origin !== 'object') return false;
  const o = origin as Record<string, unknown>;
  return typeof o.kind === 'string';
}

/**
 * Check if a message has non-human origin (should be rendered as system notification, not user message).
 * CLI uses origin.kind to distinguish synthetic messages from human input.
 */
export function hasNonHumanOrigin(message: ClaudeMessage): boolean {
  if (message.type !== MESSAGE_TYPES.USER) return false;

  const raw = message.raw;
  if (!hasOriginField(raw)) return false;

  // If origin.kind exists and is not 'human', this is a synthetic message
  return raw.origin.kind !== ORIGIN_KINDS.HUMAN;
}

/**
 * Extract all text strings from a raw message's content (handles various structures).
 * Shared helper to avoid duplicating traversal logic.
 */
function extractTextsFromRaw(raw: ClaudeRawMessage | string | undefined): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const texts: string[] = [];
  const extractFromContent = (content: unknown) => {
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text);
          }
        }
      }
    }
  };
  const rawObj = raw as Record<string, unknown>;
  extractFromContent(rawObj.content);
  if (rawObj.message && typeof rawObj.message === 'object') {
    extractFromContent((rawObj.message as Record<string, unknown>).content);
  }
  return texts;
}

/**
 * Check if a message is a task_notification only message (should be rendered as system notification, not user message).
 * This is used to change message type from 'user' to 'task_notification' for proper rendering.
 */
export function isTaskNotificationOnlyMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;

  // Check raw content structures for task-notification tag
  const rawTexts = extractTextsFromRaw(message.raw);
  if (rawTexts.some(hasTaskNotificationTag)) return true;

  // Fallback: check message.content (may differ from raw when set independently)
  return typeof message.content === 'string' && hasTaskNotificationTag(message.content);
}

/**
 * Task notification status color mapping, matching CLI behavior.
 */
export const TASK_STATUS_COLORS: Record<string, string> = {
  completed: 'success',
  failed: 'error',
  killed: 'warning',
  stopped: 'text',
};

/**
 * Format task-notification for display, matching CLI's UserAgentNotificationMessage behavior.
 * Returns "● summary" with status-based color (no status text prefix).
 *
 * @param text - Raw text containing <task-notification> tags
 * @returns Object with icon, summary, and status, or null if no summary
 */
export function formatTaskNotificationForDisplay(
  text: string
): { icon: string; summary: string; status: string } | null {
  if (!text) return null;

  // Try full format first (with status)
  const matchWithStatus = TASK_NOTIFICATION_REGEX_WITH_STATUS.exec(text);
  if (matchWithStatus?.[2]) {
    const summary = matchWithStatus[2].trim();
    if (!summary) return null;
    const status = matchWithStatus[1]?.trim() ?? 'completed';
    return { icon: '●', summary, status };
  }

  // Fallback: minimal format (only summary)
  const matchNoStatus = TASK_NOTIFICATION_REGEX_NO_STATUS.exec(text);
  if (matchNoStatus?.[1]) {
    const summary = matchNoStatus[1].trim();
    if (!summary) return null;
    return { icon: '●', summary, status: 'completed' };
  }

  return null;
}

/**
 * Create a task_notification content block from raw text.
 * Shared helper to avoid duplicating creation logic across normalizeBlocks/getContentBlocks.
 */
function createTaskNotificationBlock(text: string): ClaudeContentBlock | null {
  const n = formatTaskNotificationForDisplay(text);
  if (!n) return null;
  return { type: 'task_notification' as const, icon: n.icon, summary: n.summary, status: n.status };
}

// Performance optimization constants
/**
 * Maximum number of merged message groups to cache before clearing.
 * This prevents unbounded memory growth while maintaining cache benefits.
 */
const MESSAGE_MERGE_CACHE_LIMIT = 3000;

export type LocalizeMessageFn = (text: string) => string;

export function isSyntheticToolMessageContent(
  content: string | undefined,
  rawBlocks: readonly ClaudeContentBlock[] | null | undefined
): boolean {
  if (!content || !content.trim() || !rawBlocks?.some((block) => block.type === 'tool_use')) {
    return false;
  }

  return content
    .split(/\r?\n/)
    .every((line) => {
      const trimmed = line.trim();
      return !trimmed || /^Tool:\s+[\w.-]+$/.test(trimmed);
    });
}

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

        // Check for XML tags and format accordingly
        if (hasTaskNotificationTag(rawText)) {
          const block = createTaskNotificationBlock(rawText);
          if (block) {
            blocks.push(block);
            return;
          }
        }

        if (hasCommandMessageTag(rawText)) {
          const displayContent = formatCommandForDisplay(rawText);
          if (displayContent) {
            blocks.push({
              type: 'text',
              text: localizeMessage(displayContent),
            });
            return;
          }
        }

        // Filter out messages that only contain command tags without command-message
        if (containsAnyTag(rawText, FILTERED_NORMALIZE_TAGS)) {
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
      // Handle <task-notification> messages - create special block type
      if (hasTaskNotificationTag(content)) {
        const block = createTaskNotificationBlock(content);
        if (block) return [block];
        return null;
      }

      // If has <command-message>, format for display
      if (hasCommandMessageTag(content)) {
        const displayContent = formatCommandForDisplay(content);
        if (displayContent) {
          return [{ type: 'text' as const, text: localizeMessage(displayContent) }];
        }
        // Fallback to old extraction if formatCommandForDisplay returned null
        const processedContent = extractCommandMessageContent(content);
        return [{ type: 'text' as const, text: localizeMessage(processedContent) }];
      }

      // Filter empty strings and command tags (without <command-message>)
      if (!content.trim() || containsAnyTag(content, FILTERED_NORMALIZE_TAGS)) {
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

  // Format <command-message> content using formatCommandForDisplay
  if (hasCommandMessageTag(result)) {
    const displayContent = formatCommandForDisplay(result);
    if (displayContent) {
      result = displayContent;
    } else {
      // Fallback to old extraction
      result = extractCommandMessageContent(result);
    }
  }

  // Format <task-notification> for copy/resubmit purposes
  if (hasTaskNotificationTag(result)) {
    const notification = formatTaskNotificationForDisplay(result);
    if (notification) {
      result = `${notification.icon} ${notification.summary}`;
    }
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
  // CLI: isMeta messages are hidden in normal transcript (except channel messages)
  if (message.raw && typeof message.raw === 'object' && 'isMeta' in message.raw && message.raw.isMeta === true) {
    return false;
  }

  // Note: origin.kind filtering is ONLY for title extraction (extractTitleText, sessionTitle),
  // NOT for hiding messages in the main chat. CLI displays these messages with different formats.
  // See CLI's wrapCommandText() and isVisibleInTranscript() functions.

  // Filter toolUseResult and isCompactSummary messages (CLI filters these in extractTitleText)
  if (message.raw && typeof message.raw === 'object') {
    if ('toolUseResult' in message.raw && message.raw.toolUseResult) {
      return false;
    }
    if ('isCompactSummary' in message.raw && message.raw.isCompactSummary) {
      return false;
    }
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

  // CLI renders these messages with specific components:
  // - <command-message> → UserCommandMessage (skill/slash command)
  // - <local-command-stdout/stderr> → UserLocalCommandOutputMessage
  // - <task-notification> → UserAgentNotificationMessage
  // - Plain text (like "Unknown skill: xxx") → UserPromptMessage (displayed with ❯ prefix)
  // So we should NOT filter these messages, just handle their rendering.

  // If message has <command-message>, allow it to be shown
  // (the content will be extracted by formatCommandForDisplay)
  if (rawText && hasCommandMessageTag(rawText)) {
    return true;
  }

  // Messages with <local-command-stdout> or <local-command-stderr> should be shown
  // CLI renders them with UserLocalCommandOutputMessage component
  // But for GUI, we filter these as they are internal terminal output
  if (rawText && containsAnyTag(rawText, HIDDEN_OUTPUT_TAGS)) {
    return false;
  }

  // Filter messages with command tags (internal metadata, not user input)
  // BUT keep "Unknown skill: xxx" messages which are plain text user-visible messages
  if (rawText && containsAnyTag(rawText, INTERNAL_METADATA_TAGS)) {
    return false;
  }

  // Task-notification messages are always shown — normalizeBlocks converts them
  // to task_notification blocks, no need to re-parse here (performance optimization).
  if (rawText && hasTaskNotificationTag(rawText)) {
    return true;
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
        if (block.type === 'task_notification') {
          return block.summary && block.summary.trim().length > 0;
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
    // Don't add message.content if we have task_notification blocks
    // (those are formatted from the raw XML content).
    // Note: command-message text blocks are already formatted by normalizeBlocks
    // (e.g., "/opsx:ff hello") and no longer contain raw XML tags.
    const hasSpecialBlock = rawBlocks.some((block) => block.type === 'task_notification');
    if (hasSpecialBlock) {
      return rawBlocks;
    }
    // Streaming/tool scenario: if raw doesn't have text but message.content has text, still need to show text
    const hasTextBlock = rawBlocks.some(
      (block) => block.type === 'text' && typeof block.text === 'string' && String(block.text).trim().length > 0,
    );
    if (
      !hasTextBlock &&
      message.content &&
      message.content.trim() &&
      !isSyntheticToolMessageContent(message.content, rawBlocks)
    ) {
      return [...rawBlocks, { type: 'text', text: localizeMessage(message.content) }];
    }
    return rawBlocks;
  }
  // If no raw blocks, check if content needs special handling
  if (message.content && message.content.trim()) {
    // Handle task-notification in message.content directly
    if (hasTaskNotificationTag(message.content)) {
      const block = createTaskNotificationBlock(message.content);
      if (block) return [block];
    }
    // Handle command-message in message.content directly
    if (hasCommandMessageTag(message.content)) {
      const displayContent = formatCommandForDisplay(message.content);
      if (displayContent) {
        return [{ type: 'text' as const, text: localizeMessage(displayContent) }];
      }
    }
    return [{ type: 'text', text: localizeMessage(message.content) }];
  }
  // If no content at all, return empty array instead of showing "(empty message)"
  // shouldShowMessage will filter out these messages
  return [];
}

// ---------------------------------------------------------------------------
// Helper functions for mergeConsecutiveAssistantMessages
// These functions handle the stream-ended marker cleanup and checking.
// ---------------------------------------------------------------------------

/**
 * Clear stale stream-ended markers from window global state.
 * Called once at the entry of mergeConsecutiveAssistantMessages to avoid
 * modifying global state inside a pure judgment function.
 * The marker expires after 5 seconds to allow normal history merging.
 */
const clearStaleStreamEndedMarker = (): void => {
  const lastEndedTime = (window as any).__lastStreamEndedAt;
  if (lastEndedTime && Date.now() - lastEndedTime > 5000) {
    (window as any).__lastStreamEndedTurnId = undefined;
    (window as any).__lastStreamEndedAt = undefined;
  }
};

/**
 * Check if a message has the recently-ended streaming turn ID.
 * Used to block merging of recently-ended streaming messages with history messages.
 * Returns true if the message's turnId matches the last ended streaming turn.
 */
const hasRecentlyEndedTurnId = (turnId: number | undefined): boolean => {
  const lastEndedTurnId = (window as any).__lastStreamEndedTurnId;
  return lastEndedTurnId !== undefined && lastEndedTurnId > 0 && turnId === lastEndedTurnId;
};

/**
 * Merge consecutive assistant messages to fix style inconsistencies in history
 * where Thinking and ToolUse are separated.
 */
export function mergeConsecutiveAssistantMessages(
  messages: ClaudeMessage[],
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  cache?: Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>
): ClaudeMessage[] {
  if (messages.length === 0) return [];

  // Clear stale stream-ended markers once at entry (5 second timeout)
  clearStaleStreamEndedMarker();

  const getStableId = (message: ClaudeMessage, index: number): string => {
    const rawObj = typeof message.raw === 'object' ? (message.raw as Record<string, unknown> | null) : null;
    const uuid = rawObj?.uuid;
    if (typeof uuid === 'string' && uuid) return uuid;
    if (message.timestamp) return `${message.type}-${message.timestamp}`;
    return `${message.type}-${index}`;
  };

  const getAssistantBlockSummary = (message: ClaudeMessage): { hasToolUse: boolean; hasText: boolean } => {
    const blocks = normalizeBlocksFn(message.raw) || [];
    return {
      hasToolUse: blocks.some((block) => block.type === 'tool_use'),
      hasText: blocks.some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
        || Boolean(message.content && message.content.trim()),
    };
  };

  const shouldMergeAssistantMessage = (previous: ClaudeMessage, next: ClaudeMessage): boolean => {
    // Distinct streaming turns must stay visually separated even when the
    // backend emits adjacent assistant fragments during synchronization.
    // Block merge when either side has a __turnId and they differ.
    // This prevents streaming messages from merging with history messages.
    // FIX: Also check __lastStreamEndedTurnId to distinguish recently-ended
    // streaming messages from true history messages.
    const prevTurnId = previous.__turnId;
    const nextTurnId = next.__turnId;

    // If either message has the recently-ended turn ID, block merging
    if (hasRecentlyEndedTurnId(prevTurnId) || hasRecentlyEndedTurnId(nextTurnId)) {
      return false;
    }

    // Block merge when either side has a __turnId and they differ
    if ((prevTurnId !== undefined || nextTurnId !== undefined) &&
        prevTurnId !== nextTurnId) {
      return false;
    }

    const previousSummary = getAssistantBlockSummary(previous);
    const nextSummary = getAssistantBlockSummary(next);

    // For messages without __turnId (loaded from history), allow merging across
    // tool_use boundary so that tool-execution and final answer appear as one block.
    // For streaming messages (with __turnId), keep tool_use separated from answer.
    const bothLackTurnId = prevTurnId === undefined && nextTurnId === undefined;
    if (!bothLackTurnId && previousSummary.hasToolUse !== nextSummary.hasToolUse) {
      return false;
    }

    return true;
  };

  const isToolResultOnlyUserMessage = (message: ClaudeMessage): boolean => {
    if (message.type !== 'user') {
      return false;
    }

    if ((message.content ?? '').trim() === '[tool_result]') {
      return true;
    }

    const raw = message.raw;
    if (!raw || typeof raw === 'string') {
      return false;
    }

    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return false;
    }

    return content.every((block) => block && block.type === 'tool_result');
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
      __turnId: first.__turnId,
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

    const assistantGroup: ClaudeMessage[] = [msg];
    let j = i + 1;
    let previousAssistant = msg;

    while (j < messages.length) {
      const candidate = messages[j];

      if (isToolResultOnlyUserMessage(candidate)) {
        j += 1;
        continue;
      }

      if (candidate.type === 'assistant' && shouldMergeAssistantMessage(previousAssistant, candidate)) {
        assistantGroup.push(candidate);
        previousAssistant = candidate;
        j += 1;
        continue;
      }

      break;
    }

    const group = messages.slice(i, j);
    if (assistantGroup.length <= 1) {
      result.push(msg);
      i = j;
      continue;
    }

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

    const merged = buildMergedAssistantMessage(assistantGroup);
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
