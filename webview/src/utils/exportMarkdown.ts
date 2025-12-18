import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';

/**
 * 将消息列表转换为 JSON 格式
 */
export function convertMessagesToJSON(messages: ClaudeMessage[], sessionTitle: string): string {
  const exportTime = formatTimestamp(new Date().toISOString());

  // 过滤掉不需要导出的消息
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
 * 处理单个消息以便导出
 */
function processMessageForExport(message: ClaudeMessage): any {
  const contentBlocks = getContentBlocks(message);

  // 处理内容块
  let processedBlocks: any[] = [];
  if (contentBlocks.length > 0) {
    processedBlocks = contentBlocks.map(block => processContentBlock(block));
  } else if (message.content && message.content.trim()) {
    // 如果没有内容块但有content字段，使用content
    processedBlocks = [{ type: 'text', text: message.content }];
  } else if (message.raw) {
    // 尝试从raw中提取内容
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
    raw: message.raw // 保留原始数据用于调试
  };
}

/**
 * 从raw数据中提取文本内容
 */
function extractRawContent(raw: any): string | null {
  if (!raw) return null;

  if (typeof raw === 'string') return raw;

  if (typeof raw.content === 'string') return raw.content;

  if (Array.isArray(raw.content)) {
    return raw.content
      .filter((block: any) => block && block.type === 'text')
      .map((block: any) => block.text || '')
      .join('\n');
  }

  if (raw.message?.content) {
    if (typeof raw.message.content === 'string') return raw.message.content;
    if (Array.isArray(raw.message.content)) {
      return raw.message.content
        .filter((block: any) => block && block.type === 'text')
        .map((block: any) => block.text || '')
        .join('\n');
    }
  }

  return null;
}

/**
 * 处理内容块
 */
function processContentBlock(block: ClaudeContentBlock | ToolResultBlock): any {
  if (block.type === 'text') {
    return {
      type: 'text',
      text: block.text
    };
  } else if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: (block as any).thinking,
      text: (block as any).text
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
    // 限制工具结果内容的长度
    const content = limitContentLength(toolResult.content, 10000);
    return {
      type: 'tool_result',
      tool_use_id: toolResult.tool_use_id,
      content: content,
      is_error: toolResult.is_error
    };
  } else if (block.type === 'image') {
    const imageBlock = block as any;
    return {
      type: 'image',
      src: imageBlock.src || imageBlock.source?.data,
      mediaType: imageBlock.mediaType || imageBlock.source?.media_type,
      alt: imageBlock.alt
    };
  }

  return block;
}

/**
 * 限制内容长度
 */
function limitContentLength(content: any, maxLength: number): any {
  if (typeof content === 'string') {
    if (content.length > maxLength) {
      return content.substring(0, maxLength) + '\n... (内容过长，已截断)';
    }
    return content;
  } else if (Array.isArray(content)) {
    return content.map(item => {
      if (item.text && item.text.length > maxLength) {
        return {
          ...item,
          text: item.text.substring(0, maxLength) + '\n... (内容过长，已截断)'
        };
      }
      return item;
    });
  }
  return content;
}

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm:ss 格式
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
 * 判断是否应该导出该消息
 */
function shouldExportMessage(message: ClaudeMessage): boolean {
  // 跳过特殊的命令消息
  const text = getMessageText(message);
  if (text && (
    text.includes('<command-name>') ||
    text.includes('<local-command-stdout>') ||
    text.includes('<local-command-stderr>') ||
    text.includes('<command-message>') ||
    text.includes('<command-args>')
  )) {
    return false;
  }

  return true;
}

/**
 * 获取消息的文本内容
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
      .filter((block: any) => block && block.type === 'text')
      .map((block: any) => block.text ?? '')
      .join('\n');
  }

  if (raw.message?.content && Array.isArray(raw.message.content)) {
    return raw.message.content
      .filter((block: any) => block && block.type === 'text')
      .map((block: any) => block.text ?? '')
      .join('\n');
  }

  return '';
}

/**
 * 获取消息的内容块
 */
function getContentBlocks(message: ClaudeMessage): (ClaudeContentBlock | ToolResultBlock)[] {
  // 优先从 raw 中获取
  if (message.raw) {
    const rawBlocks = normalizeBlocks(message.raw);
    if (rawBlocks && rawBlocks.length > 0) {
      return rawBlocks;
    }
  }

  // 如果有 content 字段，作为文本块
  if (message.content && message.content.trim()) {
    return [{ type: 'text', text: message.content }];
  }

  return [];
}

/**
 * 规范化内容块
 */
function normalizeBlocks(raw: any): (ClaudeContentBlock | ToolResultBlock)[] | null {
  if (!raw) {
    return null;
  }

  let contentArray: any[] | null = null;

  // 处理后端返回的 ConversationMessage 格式
  if (raw.message && Array.isArray(raw.message.content)) {
    contentArray = raw.message.content;
  }
  // 处理其他格式
  else if (Array.isArray(raw)) {
    contentArray = raw;
  } else if (Array.isArray(raw.content)) {
    contentArray = raw.content;
  } else if (typeof raw.content === 'string' && raw.content.trim()) {
    return [{ type: 'text', text: raw.content }];
  } else if (raw.message && typeof raw.message.content === 'string' && raw.message.content.trim()) {
    return [{ type: 'text', text: raw.message.content }];
  }

  if (contentArray) {
    return contentArray.map((block: any) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'thinking') {
        return { type: 'thinking', thinking: block.thinking, text: block.text };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error
        };
      }
      if (block.type === 'image') {
        return { type: 'image', src: block.source?.data, mediaType: block.source?.media_type };
      }
      return block;
    });
  }

  return null;
}

/**
 * 触发文件下载（通过后端保存）
 */
export function downloadJSON(content: string, filename: string): void {
  // 通过后端保存文件，显示文件选择对话框
  const payload = JSON.stringify({
    content: content,
    filename: filename.endsWith('.json') ? filename : `${filename}.json`
  });

  if (window.sendToJava) {
    window.sendToJava(`save_json:${payload}`);
  } else {
    console.error('[Frontend] sendToJava not available, falling back to browser download');
    // 降级方案：使用浏览器下载
    fallbackBrowserDownload(content, filename);
  }
}

/**
 * 降级方案：浏览器直接下载
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
