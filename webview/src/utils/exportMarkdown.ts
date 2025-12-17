import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';

/**
 * 将消息列表转换为 Markdown 格式（带 YAML front matter 和 JSON 数据）
 */
export function convertMessagesToMarkdown(messages: ClaudeMessage[], sessionTitle: string): string {
  const lines: string[] = [];
  const exportTime = new Date().toISOString();

  // 添加 YAML front matter
  lines.push('---');
  lines.push(`title: "${sessionTitle.replace(/"/g, '\\"')}"`);
  lines.push(`exportTime: ${exportTime}`);
  lines.push(`messageCount: ${messages.length}`);
  lines.push(`format: claude-chat-export-v1`);
  lines.push('---');
  lines.push('');

  // 添加标题
  lines.push(`# ${sessionTitle}`);
  lines.push('');
  lines.push(`> 导出时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push(`> 消息数量: ${messages.length} 条`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 遍历消息，合并连续的同角色消息
  let lastRole: string | null = null;
  let lastTimestamp: string | null = null;

  for (const message of messages) {
    const role = message.type;

    // 跳过空消息和某些特殊消息
    if (!shouldExportMessage(message)) {
      continue;
    }

    // 判断是否需要添加新的角色标题
    // 只有当角色变化，或者时间戳差异超过1秒时，才添加新的标题
    const needNewHeader = lastRole !== role ||
      (message.timestamp && lastTimestamp &&
       Math.abs(new Date(message.timestamp).getTime() - new Date(lastTimestamp).getTime()) > 1000);

    if (needNewHeader) {
      // 如果不是第一条消息，先添加分隔线
      if (lastRole !== null) {
        lines.push('---');
        lines.push('');
      }

      // 添加角色标题
      if (role === 'user') {
        lines.push('## 👤 User');
      } else if (role === 'assistant') {
        lines.push('## 🤖 Assistant');
      } else if (role === 'error') {
        lines.push('## ⚠️ Error');
      } else {
        lines.push(`## ${role}`);
      }

      // 添加时间戳
      if (message.timestamp) {
        lines.push(`*${formatTimestamp(message.timestamp)}*`);
      }

      lines.push('');

      lastRole = role;
      lastTimestamp = message.timestamp || null;
    }

    // 处理消息内容
    const contentBlocks = getContentBlocks(message);

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        // 处理文本中的代码块，确保代码块标记前有空行
        const text = block.text || '';
        const processedText = ensureCodeBlockNewlines(text);
        lines.push(processedText);
        lines.push('');
      } else if (block.type === 'thinking') {
        lines.push('');
        lines.push('**💭 思考过程**');
        lines.push('');
        // 处理思考内容中的代码块
        const thinkingText = (block as any).thinking || (block as any).text || '';
        const processedThinking = ensureCodeBlockNewlines(thinkingText);
        lines.push(processedThinking);
        lines.push('');
      } else if (block.type === 'tool_use') {
        // 格式化工具调用，使其更接近界面显示
        const toolName = block.name || 'unknown';
        const input = block.input as any;

        if (toolName === 'Task') {
          // Task 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push(`### 🔧 任务调用: ${toolName}`);
          lines.push('');
          if (input?.description) {
            lines.push(`**${input.description}**`);
            lines.push('');
          }
          if (input?.prompt) {
            lines.push('#### 💬 提示词 (PROMPT)');
            lines.push('');
            lines.push('');
            lines.push('```');
            lines.push(input.prompt);
            lines.push('```');
            lines.push('');
          }
          if (input?.subagent_type) {
            lines.push('#### 📋 子代理类型');
            lines.push('');
            lines.push(`\`${input.subagent_type}\``);
            lines.push('');
          }
          if (input?.model) {
            lines.push('#### 🤖 MODEL');
            lines.push('');
            lines.push(`\`${input.model}\``);
            lines.push('');
          }
        } else if (toolName === 'Bash') {
          // Bash 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push('### 🔧 工具调用: Bash');
          lines.push('');
          if (input?.description) {
            lines.push(`**描述:** ${input.description}`);
            lines.push('');
          }
          if (input?.command) {
            lines.push('**命令:**');
            lines.push('');
            lines.push('');
            lines.push('```bash');
            lines.push(input.command);
            lines.push('```');
            lines.push('');
          }
        } else if (toolName === 'Read') {
          // Read 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push('### 📖 工具调用: Read');
          lines.push('');
          if (input?.file_path) {
            lines.push(`**文件路径:** \`${input.file_path}\``);
            lines.push('');
          }
          if (input?.offset !== undefined || input?.limit !== undefined) {
            lines.push(`**读取范围:** offset=${input.offset || 0}, limit=${input.limit || 'all'}`);
            lines.push('');
          }
        } else if (toolName === 'Edit') {
          // Edit 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push('### ✏️ 工具调用: Edit');
          lines.push('');
          if (input?.file_path) {
            lines.push(`**文件路径:** \`${input.file_path}\``);
            lines.push('');
          }
          if (input?.old_string) {
            lines.push('**原内容:**');
            lines.push('');
            lines.push('');
            lines.push('```');
            lines.push(input.old_string.substring(0, 200) + (input.old_string.length > 200 ? '...' : ''));
            lines.push('```');
            lines.push('');
          }
          if (input?.new_string) {
            lines.push('**新内容:**');
            lines.push('');
            lines.push('');
            lines.push('```');
            lines.push(input.new_string.substring(0, 200) + (input.new_string.length > 200 ? '...' : ''));
            lines.push('```');
            lines.push('');
          }
        } else if (toolName === 'Write') {
          // Write 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push('### 📝 工具调用: Write');
          lines.push('');
          if (input?.file_path) {
            lines.push(`**文件路径:** \`${input.file_path}\``);
            lines.push('');
          }
          if (input?.content) {
            lines.push('**内容预览:**');
            lines.push('');
            lines.push('');
            lines.push('```');
            const preview = input.content.substring(0, 300);
            lines.push(preview + (input.content.length > 300 ? '\n... (内容过长，已截断)' : ''));
            lines.push('```');
            lines.push('');
          }
        } else if (toolName === 'Grep') {
          // Grep 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push('### 🔍 工具调用: Grep');
          lines.push('');
          if (input?.pattern) {
            lines.push(`**搜索模式:** \`${input.pattern}\``);
            lines.push('');
          }
          if (input?.path) {
            lines.push(`**搜索路径:** \`${input.path}\``);
            lines.push('');
          }
          if (input?.output_mode) {
            lines.push(`**输出模式:** \`${input.output_mode}\``);
            lines.push('');
          }
        } else if (toolName === 'Glob') {
          // Glob 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push('### 🔍 工具调用: Glob');
          lines.push('');
          if (input?.pattern) {
            lines.push(`**匹配模式:** \`${input.pattern}\``);
            lines.push('');
          }
          if (input?.path) {
            lines.push(`**搜索路径:** \`${input.path}\``);
            lines.push('');
          }
        } else if (toolName === 'TodoWrite') {
          // TodoWrite 工具特殊处理
          lines.push('---');
          lines.push('');
          lines.push('### 🔧 工具调用: TodoWrite');
          lines.push('');
          if (input?.todos && Array.isArray(input.todos)) {
            lines.push('**任务列表:**');
            lines.push('');
            for (const todo of input.todos) {
              const statusIcon = todo.status === 'completed' ? '✓' :
                                todo.status === 'in_progress' ? '◐' : '○';
              const statusText = todo.status === 'completed' ? '完成' :
                                todo.status === 'in_progress' ? '进行中' : '待处理';
              lines.push(`- [${statusIcon}] **${statusText}** ${todo.content}`);
            }
            lines.push('');
          }
        } else {
          // 其他工具的通用处理
          lines.push('---');
          lines.push('');
          lines.push(`### 🔧 工具调用: ${toolName}`);
          lines.push('');
          if (block.input) {
            lines.push('');
            lines.push('```json');
            lines.push(JSON.stringify(block.input, null, 2));
            lines.push('```');
            lines.push('');
          }
        }
      } else if (block.type === 'tool_result') {
        const toolResult = block as ToolResultBlock;
        lines.push('#### 📤 工具结果');
        lines.push('');

        if (toolResult.is_error) {
          lines.push('> ⚠️ 错误');
          lines.push('');
        }

        const content = toolResult.content;
        if (typeof content === 'string') {
          // 限制输出长度，避免导出文件过大
          const maxLength = 5000;
          const truncated = content.length > maxLength;
          lines.push('');
          lines.push('```');
          lines.push(content.substring(0, maxLength));
          if (truncated) {
            lines.push('');
            lines.push('... (输出过长，已截断)');
          }
          lines.push('```');
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.text) {
              const maxLength = 5000;
              const text = item.text;
              const truncated = text.length > maxLength;
              lines.push('');
              lines.push('```');
              lines.push(text.substring(0, maxLength));
              if (truncated) {
                lines.push('');
                lines.push('... (输出过长，已截断)');
              }
              lines.push('```');
            }
          }
        }
        lines.push('');
      } else if (block.type === 'image') {
        const imageBlock = block as any;
        const src = imageBlock.src || imageBlock.source?.data;
        const mediaType = imageBlock.mediaType || imageBlock.source?.media_type || 'image/png';
        const alt = imageBlock.alt || '图片';

        if (src) {
          // 如果 src 已经包含 data: 前缀，直接使用
          if (src.startsWith('data:')) {
            lines.push(`![${alt}](${src})`);
          } else {
            // 否则构建完整的 data URL
            lines.push(`![${alt}](data:${mediaType};base64,${src})`);
          }
        } else {
          // 没有图片数据时，显示占位符
          lines.push(`![${alt}]()`);
        }
        lines.push('');
      }
    }
  }

  // 最后添加一个分隔线
  if (lastRole !== null) {
    lines.push('---');
  }

  return lines.join('\n');
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
  const rawBlocks = normalizeBlocks(message.raw);
  if (rawBlocks && rawBlocks.length > 0) {
    return rawBlocks;
  }

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

  if (Array.isArray(raw)) {
    contentArray = raw;
  } else if (Array.isArray(raw.content)) {
    contentArray = raw.content;
  } else if (raw.message && Array.isArray(raw.message.content)) {
    contentArray = raw.message.content;
  } else if (typeof raw.content === 'string' && raw.content.trim()) {
    return [{ type: 'text', text: raw.content }];
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
 * 确保文本中的代码块标记前有空行
 */
function ensureCodeBlockNewlines(text: string): string {
  if (!text) return text;

  const lines = text.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检查当前行是否包含代码块标记
    if (line.includes('```')) {
      // 检查 ``` 前面是否有其他内容
      const beforeBackticks = line.substring(0, line.indexOf('```'));

      if (beforeBackticks.trim().length > 0) {
        // 如果 ``` 前面有内容，将这行拆分为两行
        result.push(beforeBackticks);
        result.push(''); // 添加空行
        result.push(line.substring(line.indexOf('```')));
      } else {
        // 检查前一行是否为空
        if (result.length > 0 && result[result.length - 1].trim() !== '') {
          result.push(''); // 添加空行
        }
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * 格式化时间戳
 */
function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (e) {
    return timestamp;
  }
}

/**
 * 触发文件下载（通过后端保存）
 */
export function downloadMarkdown(content: string, filename: string): void {
  // 通过后端保存文件，显示文件选择对话框
  const payload = JSON.stringify({
    content: content,
    filename: filename.endsWith('.md') ? filename : `${filename}.md`
  });

  if (window.sendToJava) {
    window.sendToJava(`save_markdown:${payload}`);
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
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.md') ? filename : `${filename}.md`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
