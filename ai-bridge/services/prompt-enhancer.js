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

// Context length limits (in characters) to avoid exceeding model token limits
const MAX_SELECTED_CODE_LENGTH = 2000;      // Max length for selected code
const MAX_CURSOR_CONTEXT_LENGTH = 1000;     // Max length for cursor context
const MAX_CURRENT_FILE_LENGTH = 3000;       // Max length for current file content
const MAX_RELATED_FILES_LENGTH = 2000;      // Total length limit for related files
const MAX_SINGLE_RELATED_FILE_LENGTH = 500; // Max length per related file

/**
 * Read input from stdin.
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
 * Truncate text to a specified length while preserving integrity.
 * @param {string} text - Original text
 * @param {number} maxLength - Maximum length
 * @param {boolean} fromEnd - Whether to truncate from the end (defaults to truncating from the start)
 * @returns {string} - Truncated text
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
 * Get the programming language name for a file extension.
 * @param {string} filePath - File path
 * @returns {string} - Language name
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
 * Build a complete prompt with context information.
 * Integrates context by priority: selected code > cursor position > current file > related files.
 *
 * @param {string} originalPrompt - Original prompt
 * @param {Object} context - Context information
 * @param {string} context.selectedCode - User-selected code
 * @param {Object} context.currentFile - Current file information
 * @param {string} context.currentFile.path - File path
 * @param {string} context.currentFile.content - File content
 * @param {string} context.currentFile.language - Language type
 * @param {Object} context.cursorPosition - Cursor position
 * @param {number} context.cursorPosition.line - Line number
 * @param {number} context.cursorPosition.column - Column number
 * @param {string} context.cursorContext - Code snippet around the cursor
 * @param {Array} context.relatedFiles - Related file list
 * @param {string} context.projectType - Project type
 * @returns {string} - The constructed complete prompt
 */
function buildFullPrompt(originalPrompt, context) {
  let fullPrompt = `Please optimize the following prompt:\n\n${originalPrompt}`;

  // If there's no context information, return as-is
  if (!context) {
    return fullPrompt;
  }

  const contextParts = [];

  // 1. Highest priority: user-selected code
  if (context.selectedCode && context.selectedCode.trim()) {
    const truncatedCode = truncateText(context.selectedCode, MAX_SELECTED_CODE_LENGTH);
    const language = context.currentFile?.language || getLanguageFromPath(context.currentFile?.path) || 'text';
    contextParts.push(`[User Selected Code]\n\`\`\`${language}\n${truncatedCode}\n\`\`\``);
    console.log(`[PromptEnhancer] Added selected code context, length: ${context.selectedCode.length}`);
  }

  // 2. Second priority: cursor position context (only used when no code is selected)
  if (!context.selectedCode && context.cursorContext && context.cursorContext.trim()) {
    const truncatedContext = truncateText(context.cursorContext, MAX_CURSOR_CONTEXT_LENGTH);
    const language = context.currentFile?.language || getLanguageFromPath(context.currentFile?.path) || 'text';
    const lineInfo = context.cursorPosition ? ` (line ${context.cursorPosition.line})` : '';
    contextParts.push(`[Code Around Cursor${lineInfo}]\n\`\`\`${language}\n${truncatedContext}\n\`\`\``);
    console.log(`[PromptEnhancer] Added cursor context, length: ${context.cursorContext.length}`);
  }

  // 3. Current file basic info (always included when available)
  if (context.currentFile) {
    const { path, language, content } = context.currentFile;
    let fileInfo = '';

    if (path) {
      const lang = language || getLanguageFromPath(path);
      fileInfo = `[Current File] ${path}\n[Language Type] ${lang}`;

      // If no selected code or cursor context, include a portion of the file content
      if (!context.selectedCode && !context.cursorContext && content && content.trim()) {
        const truncatedContent = truncateText(content, MAX_CURRENT_FILE_LENGTH);
        fileInfo += `\n[File Content Preview]\n\`\`\`${lang}\n${truncatedContent}\n\`\`\``;
        console.log(`[PromptEnhancer] Added file content preview, length: ${content.length}`);
      }

      contextParts.push(fileInfo);
      console.log(`[PromptEnhancer] Added current file info: ${path}`);
    }
  }

  // 4. Lowest priority: related file information
  if (context.relatedFiles && Array.isArray(context.relatedFiles) && context.relatedFiles.length > 0) {
    let totalLength = 0;
    const relatedFilesInfo = [];

    for (const file of context.relatedFiles) {
      if (totalLength >= MAX_RELATED_FILES_LENGTH) {
        console.log(`[PromptEnhancer] Related files total length reached limit, skipping remaining files`);
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
      console.log(`[PromptEnhancer] Added ${relatedFilesInfo.length} related file(s)`);
    }
  }

  // 5. Project type information
  if (context.projectType) {
    contextParts.push(`[Project Type] ${context.projectType}`);
    console.log(`[PromptEnhancer] Added project type: ${context.projectType}`);
  }

  // Combine all context information
  if (contextParts.length > 0) {
    fullPrompt += '\n\n---\nThe following is relevant context information, please refer to it when optimizing the prompt:\n\n' + contextParts.join('\n\n');
  }

  return fullPrompt;
}

/**
 * Enhance a prompt.
 * @param {string} originalPrompt - Original prompt
 * @param {string} systemPrompt - System prompt
 * @param {string} model - Model to use (optional, frontend model ID)
 * @param {Object} context - Context information (optional)
 * @returns {Promise<string>} - Enhanced prompt
 */
async function enhancePrompt(originalPrompt, systemPrompt, model, context) {
  try {
    const sdk = await ensureClaudeSdk();
    const { query } = sdk;

    // Set environment variables (same as normal conversation)
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // Set up API Key (this sets the correct environment variables)
    const config = setupApiKey();

    console.log(`[PromptEnhancer] Auth type: ${config.authType}`);
    console.log(`[PromptEnhancer] Base URL: ${config.baseUrl || 'https://api.anthropic.com'}`);

    // Map model ID to the name expected by the SDK
    const sdkModelName = mapModelIdToSdkName(model);
    console.log(`[PromptEnhancer] Model mapping: ${model} -> ${sdkModelName}`);

    // Use the user's home directory as the working directory
    const workingDirectory = getRealHomeDir();

    // Build complete prompt with context information
    const fullPrompt = buildFullPrompt(originalPrompt, context);
    console.log(`[PromptEnhancer] Full prompt length: ${fullPrompt.length}`);

    // Prepare options
    // Note: Prompt enhancement is a simple task that doesn't require tool calls
    const options = {
      cwd: workingDirectory,
      permissionMode: 'bypassPermissions',  // Prompt enhancement doesn't need tool permissions
      model: sdkModelName,
      maxTurns: 1,  // Prompt enhancement only needs a single turn, no tool calls
      // Use custom system prompt (passed as a string directly, not as an object)
      systemPrompt: systemPrompt,
      settingSources: ['user', 'project', 'local'],
    };

    console.log(`[PromptEnhancer] Calling Claude Agent SDK...`);

    // Call the query function
    const result = query({
      prompt: fullPrompt,
      options
    });

    // Collect response text
    let responseText = '';
    let messageCount = 0;

    for await (const msg of result) {
      messageCount++;
      console.log(`[PromptEnhancer] Received message #${messageCount}, type: ${msg.type}`);

      // Process assistant messages
      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              responseText += block.text;
              console.log(`[PromptEnhancer] Received text: ${block.text.substring(0, 100)}...`);
            }
          }
        } else if (typeof content === 'string') {
          responseText += content;
        }
      }
    }

    console.log(`[PromptEnhancer] Total messages received: ${messageCount}`);
    console.log(`[PromptEnhancer] Response text length: ${responseText.length}`);

    if (responseText.trim()) {
      return responseText.trim();
    }

    throw new Error('AI response is empty');
  } catch (error) {
    console.error('[PromptEnhancer] Enhancement failed:', error.message);
    throw error;
  }
}

/**
 * Main function.
 */
async function main() {
  try {
    // Read stdin input
    const input = await readStdin();
    const data = JSON.parse(input);

    const { prompt, systemPrompt, model, context } = data;

    if (!prompt) {
      console.log('[ENHANCED]');
      process.exit(0);
    }

    // Log context information
    if (context) {
      console.log(`[PromptEnhancer] Received context info:`);
      if (context.selectedCode) {
        console.log(`  - Selected code: ${context.selectedCode.length} chars`);
      }
      if (context.currentFile) {
        console.log(`  - Current file: ${context.currentFile.path}`);
      }
      if (context.cursorPosition) {
        console.log(`  - Cursor position: line ${context.cursorPosition.line}`);
      }
      if (context.relatedFiles) {
        console.log(`  - Related files: ${context.relatedFiles.length}`);
      }
    } else {
      console.log(`[PromptEnhancer] No context info received`);
    }

    // Enhance the prompt (passing context information)
    const enhancedPrompt = await enhancePrompt(prompt, systemPrompt, model, context);

    // Output the result
    // Replace newlines with a special marker to prevent Java's readLine() from reading only the first line
    const encodedPrompt = enhancedPrompt.replace(/\n/g, '{{NEWLINE}}');
    console.log(`[ENHANCED]${encodedPrompt}`);
    process.exit(0);
  } catch (error) {
    console.error('[PromptEnhancer] Error:', error.message);
    console.log(`[ENHANCED]Enhancement failed: ${error.message}`);
    process.exit(1);
  }
}

main();
