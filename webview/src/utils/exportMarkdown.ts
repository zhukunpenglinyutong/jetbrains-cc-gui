import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock, ClaudeRawMessage } from '../types';
import {
  hasCommandMessageTag,
  hasTaskNotificationTag,
  formatCommandForResubmit,
  formatTaskNotificationForDisplay,
  HIDDEN_OUTPUT_TAGS,
  INTERNAL_METADATA_TAGS,
  containsAnyTag,
} from './messageUtils';

// ---------------------------------------------------------------------------
// Type guard for text blocks in raw content arrays
// ---------------------------------------------------------------------------

/** Type guard: check if an unknown block is a text content block */
function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return !!block && typeof block === 'object'
    && (block as Record<string, unknown>).type === 'text'
    && typeof (block as Record<string, unknown>).text === 'string';
}

/**
 * Convert a message list to JSON format
 */
export function convertMessagesToJSON(messages: ClaudeMessage[], sessionTitle: string): string {
  const exportTime = formatTimestamp(new Date().toISOString());

  // Filter out messages that should not be exported
  const filteredMessages = messages
    .filter(msg => shouldExportMessage(msg))
    .map(msg => processMessageForExport(msg));

  const exportData = {
    format: 'claude-chat-export-v2',
    exportTime,
    sessionTitle,
    messageCount: filteredMessages.length,
    messages: filteredMessages
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Process a single message for export
 */
function processMessageForExport(message: ClaudeMessage) {
  const contentBlocks = getContentBlocks(message);

  // Process content blocks
  type ProcessedBlock = { type: string } & Record<string, unknown>;
  let processedBlocks: ProcessedBlock[] = [];
  if (contentBlocks.length > 0) {
    processedBlocks = contentBlocks.map(block => processContentBlock(block)) as ProcessedBlock[];
  } else if (message.content && message.content.trim()) {
    // If no content blocks but content field exists, use content
    processedBlocks = [{ type: 'text', text: message.content }];
  } else if (message.raw) {
    // Try extracting content from raw
    const rawContent = extractRawContent(message.raw);
    if (rawContent) {
      processedBlocks = [{ type: 'text', text: rawContent }];
    }
  }

  return {
    type: message.type,
    timestamp: message.timestamp ? formatTimestamp(message.timestamp) : null,
    content: message.content,
    contentBlocks: processedBlocks,
    raw: message.raw // Preserve raw data for debugging
  };
}

/**
 * Extract text content from raw data
 */
function extractRawContent(raw: ClaudeRawMessage | unknown): string | null {
  if (!raw) return null;

  if (typeof raw === 'string') return raw;

  const rawObj = raw as Record<string, unknown>;
  if (typeof rawObj.content === 'string') return rawObj.content;

  if (Array.isArray(rawObj.content)) {
    return rawObj.content
      .filter(isTextBlock)
      .map(block => block.text || '')
      .join('\n');
  }

  if (rawObj.message && typeof rawObj.message === 'object') {
    const msg = rawObj.message as Record<string, unknown>;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(isTextBlock)
        .map(block => block.text || '')
        .join('\n');
    }
  }

  return null;
}

/**
 * Process a content block
 */
function processContentBlock(block: ClaudeContentBlock | ToolResultBlock) {
  if (block.type === 'text') {
    return {
      type: 'text',
      text: block.text
    };
  } else if (block.type === 'thinking') {
    const tb = block as { type: 'thinking'; thinking?: string; text?: string };
    return {
      type: 'thinking',
      thinking: tb.thinking,
      text: tb.text
    };
  } else if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input
    };
  } else if (block.type === 'tool_result') {
    const toolResult = block as ToolResultBlock;
    // Limit tool result content length
    const content = limitContentLength(toolResult.content, 10000);
    return {
      type: 'tool_result',
      tool_use_id: toolResult.tool_use_id,
      content: content,
      is_error: toolResult.is_error
    };
  } else if (block.type === 'image') {
    const ib = block as { type: 'image'; src?: string; source?: { data?: string; media_type?: string }; mediaType?: string; alt?: string };
    return {
      type: 'image',
      src: ib.src || ib.source?.data,
      mediaType: ib.mediaType || ib.source?.media_type,
      alt: ib.alt
    };
  } else if (block.type === 'task_notification') {
    const tb = block as { type: 'task_notification'; icon?: string; summary?: string };
    // Export task_notification as formatted text: "● summary"
    return {
      type: 'text',
      text: `${tb.icon || '●'} ${tb.summary || ''}`
    };
  }

  return block;
}

/**
 * Limit content length
 */
function limitContentLength(content: unknown, maxLength: number): unknown {
  if (typeof content === 'string') {
    if (content.length > maxLength) {
      return content.substring(0, maxLength) + '\n... (content too long, truncated)';
    }
    return content;
  } else if (Array.isArray(content)) {
    return content.map(item => {
      if (item && typeof item === 'object') {
        const objItem = item as Record<string, unknown>;
        const text = objItem.text as string | undefined;
        if (text && text.length > maxLength) {
          return {
            ...item,
            text: text.substring(0, maxLength) + '\n... (content too long, truncated)'
          };
        }
      }
      return item;
    });
  }
  return content;
}

/**
 * Format timestamp to YYYY-MM-DD HH:mm:ss format
 */
function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (e) {
    return timestamp;
  }
}

/**
 * Determine whether a message should be exported
 */
function shouldExportMessage(message: ClaudeMessage): boolean {
  const text = getMessageText(message);

  // Allow task-notification messages - they will be formatted properly
  if (text && hasTaskNotificationTag(text)) {
    return true;
  }

  // Allow command messages with <command-message> - format with formatCommandForResubmit
  if (text && hasCommandMessageTag(text)) {
    return true;
  }

  // Skip special internal tags (but not command-message or task-notification)
  if (text && (containsAnyTag(text, HIDDEN_OUTPUT_TAGS) || containsAnyTag(text, INTERNAL_METADATA_TAGS))) {
    return false;
  }

  return true;
}

/**
 * Get the text content of a message
 */
function getMessageText(message: ClaudeMessage): string {
  if (message.content) {
    return message.content;
  }

  const raw = message.raw;
  if (!raw) {
    return '';
  }

  if (typeof raw === 'string') {
    return raw;
  }

  if (typeof raw.content === 'string') {
    return raw.content;
  }

  if (Array.isArray(raw.content)) {
    return raw.content
      .filter(isTextBlock)
      .map(block => block.text ?? '')
      .join('\n');
  }

  if (raw.message?.content && Array.isArray(raw.message.content)) {
    return raw.message.content
      .filter(isTextBlock)
      .map(block => block.text ?? '')
      .join('\n');
  }

  return '';
}

/**
 * Get content blocks from a message
 */
function getContentBlocks(message: ClaudeMessage): (ClaudeContentBlock | ToolResultBlock)[] {
  // Prefer extracting from raw
  if (message.raw) {
    const rawBlocks = normalizeBlocks(message.raw);
    if (rawBlocks && rawBlocks.length > 0) {
      return rawBlocks;
    }
  }

  // If content field exists, treat as text block
  if (message.content && message.content.trim()) {
    return [{ type: 'text', text: message.content }];
  }

  return [];
}

/**
 * Normalize content blocks
 */
function normalizeBlocks(raw: ClaudeRawMessage | unknown): (ClaudeContentBlock | ToolResultBlock)[] | null {
  if (!raw) {
    return null;
  }

  // Type-safe access helpers
  const rawObj = raw as Record<string, unknown>;
  let contentArray: unknown[] | null = null;

  // Handle backend ConversationMessage format
  if (rawObj.message && typeof rawObj.message === 'object') {
    const msg = rawObj.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      contentArray = msg.content;
    }
  }
  // Handle other formats
  else if (Array.isArray(raw)) {
    contentArray = raw as unknown[];
  } else if (Array.isArray(rawObj.content)) {
    contentArray = rawObj.content;
  } else if (typeof rawObj.content === 'string' && (rawObj.content as string).trim()) {
    return [{ type: 'text', text: rawObj.content as string }];
  } else if (rawObj.message && typeof rawObj.message === 'object') {
    const msg = rawObj.message as Record<string, unknown>;
    if (typeof msg.content === 'string' && (msg.content as string).trim()) {
      return [{ type: 'text', text: msg.content as string }];
    }
  }

  if (contentArray) {
    return contentArray.map((block: unknown) => {
      if (!block || typeof block !== 'object') return block;
      const b = block as Record<string, unknown>;
      if (b.type === 'text') {
        let text = (b.text as string) || '';
        // Format command messages for export using formatCommandForResubmit
        if (hasCommandMessageTag(text)) {
          const formatted = formatCommandForResubmit(text);
          if (formatted) {
            text = formatted;
          }
        }
        // Format task-notification for export
        if (hasTaskNotificationTag(text)) {
          const notification = formatTaskNotificationForDisplay(text);
          if (notification) {
            text = `${notification.icon} ${notification.summary}`;
          }
        }
        return { type: 'text', text };
      }
      if (b.type === 'thinking') {
        return { type: 'thinking', thinking: b.thinking, text: b.text };
      }
      if (b.type === 'tool_use') {
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      }
      if (b.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: b.content,
          is_error: b.is_error
        };
      }
      if (b.type === 'image') {
        const source = b.source as Record<string, unknown> | undefined;
        return { type: 'image', src: source?.data, mediaType: source?.media_type };
      }
      if (b.type === 'task_notification') {
        return { type: 'task_notification', icon: b.icon, summary: b.summary, status: b.status };
      }
      return block;
    }) as (ClaudeContentBlock | ToolResultBlock)[];
  }

  return null;
}

/**
 * Trigger file download (via backend save)
 */
export function downloadJSON(content: string, filename: string): void {
  // Save file via backend, showing file chooser dialog
  const payload = JSON.stringify({
    content: content,
    filename: filename.endsWith('.json') ? filename : `${filename}.json`
  });

  if (window.sendToJava) {
    window.sendToJava(`save_json:${payload}`);
  } else {
    console.error('[Frontend] sendToJava not available, falling back to browser download');
    // Fallback: use browser download
    fallbackBrowserDownload(content, filename);
  }
}

/**
 * Fallback: direct browser download
 */
function fallbackBrowserDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
