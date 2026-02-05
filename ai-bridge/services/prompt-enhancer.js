/**
 * Prompt Enhancement Service.
 * Uses Claude Agent SDK to call AI to optimize and rewrite user prompts.
 * Uses the same authentication method and configuration as normal conversation.
 *
 * Supports context information:
 * - User selected code snippets
 * - Current open file information (path, content, language type)
 * - Cursor position and surrounding code
 * - Related file information
 */

import { loadClaudeSdk, isClaudeSdkAvailable } from '../utils/sdk-loader.js';
import { setupApiKey, loadClaudeSettings } from '../config/api-config.js';
import { mapModelIdToSdkName } from '../utils/model-utils.js';
import { getRealHomeDir } from '../utils/path-utils.js';

let claudeSdk = null;

async function ensureClaudeSdk() {
  if (!claudeSdk) {
    if (!isClaudeSdkAvailable()) {
      const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      throw error;
    }
    claudeSdk = await loadClaudeSdk();
  }
  return claudeSdk;
}

// 上下文长度限制（字符数），避免超出模型 token 限制
const MAX_SELECTED_CODE_LENGTH = 2000;      // 选中代码最大长度
const MAX_CURSOR_CONTEXT_LENGTH = 1000;     // 光标上下文最大长度
const MAX_CURRENT_FILE_LENGTH = 3000;       // 当前文件内容最大长度
const MAX_RELATED_FILES_LENGTH = 2000;      // 相关文件总长度限制
const MAX_SINGLE_RELATED_FILE_LENGTH = 500; // 单个相关文件最大长度

/**
 * 从 stdin 读取输入
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', reject);
  });
}

/**
 * 截断文本到指定长度，保持完整性
 * @param {string} text - 原始文本
 * @param {number} maxLength - 最大长度
 * @param {boolean} fromEnd - 是否从末尾截断（默认从开头截断）
 * @returns {string} - 截断后的文本
 */
function truncateText(text, maxLength, fromEnd = false) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  if (fromEnd) {
    return '...\n' + text.slice(-maxLength);
  }
  return text.slice(0, maxLength) + '\n...';
}

/**
 * 获取文件扩展名对应的语言名称
 * @param {string} filePath - 文件路径
 * @returns {string} - 语言名称
 */
function getLanguageFromPath(filePath) {
  if (!filePath) return 'text';

  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'go': 'go',
    'rs': 'rust',
    'rb': 'ruby',
    'php': 'php',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'swift': 'swift',
    'scala': 'scala',
    'vue': 'vue',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
  };

  return langMap[ext] || 'text';
}

/**
 * 构建包含上下文信息的完整提示词
 * 按优先级整合上下文：选中代码 > 光标位置 > 当前文件 > 相关文件
 *
 * @param {string} originalPrompt - 原始提示词
 * @param {Object} context - 上下文信息
 * @param {string} context.selectedCode - 用户选中的代码
 * @param {Object} context.currentFile - 当前文件信息
 * @param {string} context.currentFile.path - 文件路径
 * @param {string} context.currentFile.content - 文件内容
 * @param {string} context.currentFile.language - 语言类型
 * @param {Object} context.cursorPosition - 光标位置
 * @param {number} context.cursorPosition.line - 行号
 * @param {number} context.cursorPosition.column - 列号
 * @param {string} context.cursorContext - 光标周围的代码片段
 * @param {Array} context.relatedFiles - 相关文件列表
 * @param {string} context.projectType - 项目类型
 * @returns {string} - 构建的完整提示词
 */
function buildFullPrompt(originalPrompt, context) {
  let fullPrompt = `Please optimize the following prompt:\n\n${originalPrompt}`;

  // 如果没有上下文信息，直接返回
  if (!context) {
    return fullPrompt;
  }

  const contextParts = [];

  // 1. 最高优先级：用户选中的代码
  if (context.selectedCode && context.selectedCode.trim()) {
    const truncatedCode = truncateText(context.selectedCode, MAX_SELECTED_CODE_LENGTH);
    const language = context.currentFile?.language || getLanguageFromPath(context.currentFile?.path) || 'text';
    contextParts.push(`[User Selected Code]\n\`\`\`${language}\n${truncatedCode}\n\`\`\``);
    console.log(`[PromptEnhancer] 添加选中代码上下文，长度: ${context.selectedCode.length}`);
  }

  // 2. 次高优先级：光标位置上下文（仅当没有选中代码时使用）
  if (!context.selectedCode && context.cursorContext && context.cursorContext.trim()) {
    const truncatedContext = truncateText(context.cursorContext, MAX_CURSOR_CONTEXT_LENGTH);
    const language = context.currentFile?.language || getLanguageFromPath(context.currentFile?.path) || 'text';
    const lineInfo = context.cursorPosition ? ` (line ${context.cursorPosition.line})` : '';
    contextParts.push(`[Code Around Cursor${lineInfo}]\n\`\`\`${language}\n${truncatedContext}\n\`\`\``);
    console.log(`[PromptEnhancer] 添加光标上下文，长度: ${context.cursorContext.length}`);
  }

  // 3. 当前文件基本信息（始终包含，如果有的话）
  if (context.currentFile) {
    const { path, language, content } = context.currentFile;
    let fileInfo = '';

    if (path) {
      const lang = language || getLanguageFromPath(path);
      fileInfo = `[Current File] ${path}\n[Language Type] ${lang}`;

      // 如果没有选中代码和光标上下文，可以包含部分文件内容
      if (!context.selectedCode && !context.cursorContext && content && content.trim()) {
        const truncatedContent = truncateText(content, MAX_CURRENT_FILE_LENGTH);
        fileInfo += `\n[File Content Preview]\n\`\`\`${lang}\n${truncatedContent}\n\`\`\``;
        console.log(`[PromptEnhancer] 添加文件内容预览，长度: ${content.length}`);
      }

      contextParts.push(fileInfo);
      console.log(`[PromptEnhancer] 添加当前文件信息: ${path}`);
    }
  }

  // 4. 最低优先级：相关文件信息
  if (context.relatedFiles && Array.isArray(context.relatedFiles) && context.relatedFiles.length > 0) {
    let totalLength = 0;
    const relatedFilesInfo = [];

    for (const file of context.relatedFiles) {
      if (totalLength >= MAX_RELATED_FILES_LENGTH) {
        console.log(`[PromptEnhancer] 相关文件总长度已达上限，跳过剩余文件`);
        break;
      }

      if (file.path) {
        let fileEntry = `- ${file.path}`;
        if (file.content && file.content.trim()) {
          const remainingLength = MAX_RELATED_FILES_LENGTH - totalLength;
          const maxLength = Math.min(MAX_SINGLE_RELATED_FILE_LENGTH, remainingLength);
          const truncatedContent = truncateText(file.content, maxLength);
          const lang = getLanguageFromPath(file.path);
          fileEntry += `\n\`\`\`${lang}\n${truncatedContent}\n\`\`\``;
          totalLength += truncatedContent.length;
        }
        relatedFilesInfo.push(fileEntry);
      }
    }

    if (relatedFilesInfo.length > 0) {
      contextParts.push(`[Related Files]\n${relatedFilesInfo.join('\n')}`);
      console.log(`[PromptEnhancer] 添加 ${relatedFilesInfo.length} 个相关文件`);
    }
  }

  // 5. 项目类型信息
  if (context.projectType) {
    contextParts.push(`[Project Type] ${context.projectType}`);
    console.log(`[PromptEnhancer] 添加项目类型: ${context.projectType}`);
  }

  // 组合所有上下文信息
  if (contextParts.length > 0) {
    fullPrompt += '\n\n---\nThe following is relevant context information, please refer to it when optimizing the prompt:\n\n' + contextParts.join('\n\n');
  }

  return fullPrompt;
}

/**
 * 增强提示词
 * @param {string} originalPrompt - 原始提示词
 * @param {string} systemPrompt - 系统提示词
 * @param {string} model - 使用的模型（可选，前端模型 ID）
 * @param {Object} context - 上下文信息（可选）
 * @returns {Promise<string>} - 增强后的提示词
 */
async function enhancePrompt(originalPrompt, systemPrompt, model, context) {
  try {
    const sdk = await ensureClaudeSdk();
    const { query } = sdk;

    // 设置环境变量（与正常对话功能相同）
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key（这会设置正确的环境变量）
    const config = setupApiKey();

    console.log(`[PromptEnhancer] 认证类型: ${config.authType}`);
    console.log(`[PromptEnhancer] Base URL: ${config.baseUrl || 'https://api.anthropic.com'}`);

    // 将模型 ID 映射为 SDK 期望的名称
    const sdkModelName = mapModelIdToSdkName(model);
    console.log(`[PromptEnhancer] 模型映射: ${model} -> ${sdkModelName}`);

    // 使用用户主目录作为工作目录
    const workingDirectory = getRealHomeDir();

    // 构建包含上下文信息的完整提示词
    const fullPrompt = buildFullPrompt(originalPrompt, context);
    console.log(`[PromptEnhancer] 完整提示词长度: ${fullPrompt.length}`);

    // 准备选项
    // 注意：提示词优化是简单任务，不需要工具调用
    const options = {
      cwd: workingDirectory,
      permissionMode: 'bypassPermissions',  // 增强提示词不需要工具权限
      model: sdkModelName,
      maxTurns: 1,  // 提示词优化只需要单轮对话，不需要工具调用
      // 使用自定义系统提示词（直接传递字符串，而不是对象格式）
      systemPrompt: systemPrompt,
      settingSources: ['user', 'project', 'local'],
    };

    console.log(`[PromptEnhancer] 开始调用 Claude Agent SDK...`);

    // 调用 query 函数
    const result = query({
      prompt: fullPrompt,
      options
    });

    // 收集响应文本
    let responseText = '';
    let messageCount = 0;

    for await (const msg of result) {
      messageCount++;
      console.log(`[PromptEnhancer] 收到消息 #${messageCount}, type: ${msg.type}`);

      // 处理助手消息
      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              responseText += block.text;
              console.log(`[PromptEnhancer] 收到文本: ${block.text.substring(0, 100)}...`);
            }
          }
        } else if (typeof content === 'string') {
          responseText += content;
        }
      }
    }

    console.log(`[PromptEnhancer] 总共收到 ${messageCount} 条消息`);
    console.log(`[PromptEnhancer] 响应文本长度: ${responseText.length}`);

    if (responseText.trim()) {
      return responseText.trim();
    }

    throw new Error('AI response is empty');
  } catch (error) {
    console.error('[PromptEnhancer] 增强失败:', error.message);
    throw error;
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    // 读取 stdin 输入
    const input = await readStdin();
    const data = JSON.parse(input);

    const { prompt, systemPrompt, model, context } = data;

    if (!prompt) {
      console.log('[ENHANCED]');
      process.exit(0);
    }

    // 记录上下文信息
    if (context) {
      console.log(`[PromptEnhancer] 收到上下文信息:`);
      if (context.selectedCode) {
        console.log(`  - 选中代码: ${context.selectedCode.length} 字符`);
      }
      if (context.currentFile) {
        console.log(`  - 当前文件: ${context.currentFile.path}`);
      }
      if (context.cursorPosition) {
        console.log(`  - 光标位置: 第 ${context.cursorPosition.line} 行`);
      }
      if (context.relatedFiles) {
        console.log(`  - 相关文件: ${context.relatedFiles.length} 个`);
      }
    } else {
      console.log(`[PromptEnhancer] 未收到上下文信息`);
    }

    // 增强提示词（传递上下文信息）
    const enhancedPrompt = await enhancePrompt(prompt, systemPrompt, model, context);

    // 输出结果
    // 将换行符替换为特殊标记，避免 Java 端 readLine() 只读取第一行
    const encodedPrompt = enhancedPrompt.replace(/\n/g, '{{NEWLINE}}');
    console.log(`[ENHANCED]${encodedPrompt}`);
    process.exit(0);
  } catch (error) {
    console.error('[PromptEnhancer] 错误:', error.message);
    console.log(`[ENHANCED]Enhancement failed: ${error.message}`);
    process.exit(1);
  }
}

main();
