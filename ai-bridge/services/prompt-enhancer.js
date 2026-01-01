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
import { homedir } from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';
import http from 'http';

// ACE MCP 配置
const ACE_SERVER_NAMES = ['auggie-mcp', 'auggie', 'augment', 'ace'];  // 可能的 ACE 服务器名称
const ACE_TIMEOUT_MS = 30000;  // ACE 调用超时时间（毫秒），增加到 30 秒以支持大型项目
const ACE_PROXY_TIMEOUT_MS = 15000;  // 代理服务调用超时（更短，因为已经预热）

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

// 缓存 ACE MCP 客户端连接
let aceClientCache = null;

/**
 * 读取 MCP 服务器配置
 * @returns {Object} MCP 服务器配置对象
 */
function readMcpConfig() {
  try {
    const claudeJsonPath = join(homedir(), '.claude.json');
    const content = readFileSync(claudeJsonPath, 'utf-8');
    const config = JSON.parse(content);
    return config.mcpServers || {};
  } catch (error) {
    console.log('[PromptEnhancer] 读取 MCP 配置失败:', error.message);
    return {};
  }
}

/**
 * 检测 ACE MCP 服务器是否可用
 * @returns {{ available: boolean, serverName: string | null, serverConfig: Object | null }}
 */
function checkAceMcpAvailability() {
  const mcpConfig = readMcpConfig();
  const configKeys = Object.keys(mcpConfig);

  console.log('[PromptEnhancer] 检测 ACE MCP 可用性，已配置的服务器:', configKeys.join(', ') || '无');

  // 查找 ACE 服务器
  for (const serverName of configKeys) {
    const normalizedName = serverName.toLowerCase().replace(/[-_\s]/g, '');

    // 检查是否匹配 ACE 服务器名称
    for (const aceName of ACE_SERVER_NAMES) {
      if (normalizedName.includes(aceName.replace(/[-_\s]/g, ''))) {
        const serverConfig = mcpConfig[serverName];

        // 验证配置有效性（需要有 command）
        if (serverConfig && serverConfig.command) {
          console.log(`[PromptEnhancer] 找到 ACE MCP 服务器: ${serverName}`);
          return {
            available: true,
            serverName,
            serverConfig
          };
        }
      }
    }
  }

  console.log('[PromptEnhancer] 未找到 ACE MCP 服务器');
  return {
    available: false,
    serverName: null,
    serverConfig: null
  };
}

/**
 * 通过 HTTP 代理服务调用 ACE MCP
 * 这是首选方式，因为代理服务维护了持久连接，避免重复索引
 *
 * @param {string} informationRequest - 要检索的信息描述
 * @param {number} proxyPort - 代理服务端口
 * @returns {Promise<string | null>} 检索到的上下文，失败返回 null
 */
async function getAceContextViaProxy(informationRequest, proxyPort) {
  return new Promise((resolve) => {
    console.log(`[PromptEnhancer] [ACE-Proxy] 通过代理服务调用 ACE (端口: ${proxyPort})`);
    console.log(`[PromptEnhancer] [ACE-Proxy] 请求内容: ${informationRequest.substring(0, 100)}...`);

    const postData = JSON.stringify({ query: informationRequest });

    const options = {
      hostname: '127.0.0.1',
      port: proxyPort,
      path: '/retrieve',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: ACE_PROXY_TIMEOUT_MS
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(data);

          if (result.success && result.context) {
            console.log(`[PromptEnhancer] [ACE-Proxy] 成功! 返回上下文长度: ${result.context.length} 字符`);
            resolve(result.context);
          } else {
            console.log(`[PromptEnhancer] [ACE-Proxy] 返回失败: ${result.error || '空结果'}`);
            resolve(null);
          }
        } catch (e) {
          console.log(`[PromptEnhancer] [ACE-Proxy] 解析响应失败: ${e.message}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.log(`[PromptEnhancer] [ACE-Proxy] 请求失败: ${e.message}`);
      resolve(null);
    });

    req.on('timeout', () => {
      console.log('[PromptEnhancer] [ACE-Proxy] 请求超时');
      req.destroy();
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * 连接到 ACE MCP 服务器并调用 codebase-retrieval 工具（直接连接方式）
 * 当代理服务不可用时使用此方法作为回退
 *
 * @param {string} informationRequest - 要检索的信息描述
 * @param {Object} serverConfig - MCP 服务器配置
 * @param {string} serverName - 服务器名称
 * @returns {Promise<string | null>} 检索到的上下文，失败返回 null
 */
async function getAceContextDirect(informationRequest, serverConfig, serverName, projectPath) {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    console.log(`[PromptEnhancer] [ACE] 开始连接 ACE MCP 服务器: ${serverName}`);
    console.log(`[PromptEnhancer] [ACE] 命令: ${serverConfig.command} ${(serverConfig.args || []).join(' ')}`);
    console.log(`[PromptEnhancer] [ACE] 工作目录: ${projectPath || '未指定'}`);

    // 创建传输层，设置正确的工作目录
    const transportOptions = {
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: { ...process.env, ...(serverConfig.env || {}) }
    };

    // 如果有项目路径，设置为工作目录
    if (projectPath) {
      transportOptions.cwd = projectPath;
    }

    const transport = new StdioClientTransport(transportOptions);

    // 创建客户端
    const client = new Client({
      name: 'prompt-enhancer',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    // 连接到服务器
    console.log('[PromptEnhancer] [ACE] 正在连接...');
    await client.connect(transport);
    console.log('[PromptEnhancer] [ACE] 连接成功!');

    // 设置超时
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('ACE 调用超时')), ACE_TIMEOUT_MS);
    });

    try {
      // 调用 codebase-retrieval 工具
      console.log('[PromptEnhancer] [ACE] 调用 codebase-retrieval 工具...');
      console.log(`[PromptEnhancer] [ACE] 请求内容: ${informationRequest.substring(0, 100)}...`);

      const callPromise = client.callTool({
        name: 'codebase-retrieval',
        arguments: {
          information_request: informationRequest
        }
      });

      const result = await Promise.race([callPromise, timeoutPromise]);
      clearTimeout(timeoutId);
      console.log('[PromptEnhancer] [ACE] 收到响应');

      // 关闭连接
      await client.close();
      console.log('[PromptEnhancer] [ACE] 连接已关闭');

      // 解析结果
      if (result && result.content) {
        console.log(`[PromptEnhancer] [ACE] 响应内容块数量: ${result.content.length}`);
        const textContent = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');

        if (textContent.trim()) {
          console.log(`[PromptEnhancer] [ACE] 成功! 返回上下文长度: ${textContent.length} 字符`);
          console.log(`[PromptEnhancer] [ACE] 上下文预览: ${textContent.substring(0, 200)}...`);
          return textContent;
        }
      }

      console.log('[PromptEnhancer] [ACE] 返回空结果');
      return null;
    } catch (innerError) {
      clearTimeout(timeoutId);
      console.log(`[PromptEnhancer] [ACE] 调用失败: ${innerError.message}`);

      // 确保关闭连接
      try {
        await client.close();
        console.log('[PromptEnhancer] [ACE] 连接已关闭（错误后清理）');
      } catch (closeError) {
        console.log(`[PromptEnhancer] [ACE] 关闭连接失败: ${closeError.message}`);
      }

      // 强制终止子进程
      try {
        transport.close();
        console.log('[PromptEnhancer] [ACE] 传输层已关闭');
      } catch (transportError) {
        console.log(`[PromptEnhancer] [ACE] 关闭传输层失败: ${transportError.message}`);
      }

      return null;
    }
  } catch (error) {
    console.log(`[PromptEnhancer] [ACE] 连接失败: ${error.message}`);
    console.log(`[PromptEnhancer] [ACE] 错误堆栈: ${error.stack}`);
    return null;
  }
}

/**
 * 获取 ACE 上下文（统一入口）
 * 优先使用代理服务，如果代理不可用则回退到直接连接
 *
 * @param {string} informationRequest - 要检索的信息描述
 * @param {Object} serverConfig - MCP 服务器配置
 * @param {string} serverName - 服务器名称
 * @param {string} projectPath - 项目路径
 * @param {number} proxyPort - 代理服务端口（可选，由 Java 端传入）
 * @returns {Promise<string | null>} 检索到的上下文，失败返回 null
 */
async function getAceContext(informationRequest, serverConfig, serverName, projectPath, proxyPort) {
  // 如果有代理端口，优先使用代理服务
  if (proxyPort && proxyPort > 0) {
    console.log(`[PromptEnhancer] [ACE] 使用代理服务模式 (端口: ${proxyPort})`);
    const result = await getAceContextViaProxy(informationRequest, proxyPort);

    if (result) {
      return result;
    }

    console.log('[PromptEnhancer] [ACE] 代理服务调用失败，回退到直接连接模式');
  }

  // 回退到直接连接
  console.log('[PromptEnhancer] [ACE] 使用直接连接模式');
  return getAceContextDirect(informationRequest, serverConfig, serverName, projectPath);
}

/**
 * 使用 ACE 上下文构建完整提示词
 * @param {string} originalPrompt - 原始提示词
 * @param {Object} context - 上下文信息
 * @param {string} aceContext - ACE 返回的上下文
 * @returns {string} 完整提示词
 */
function buildFullPromptWithAce(originalPrompt, context, aceContext) {
  const contextParts = [];

  // 添加 ACE 上下文（优先级最高）
  if (aceContext) {
    contextParts.push(`## ACE 代码库上下文（由 Augment Context Engine 提供）\n\n${aceContext}`);
  }

  // 添加选中的代码（如果有）
  if (context?.selectedCode) {
    const truncatedCode = truncateText(context.selectedCode, MAX_SELECTED_CODE_LENGTH);
    contextParts.push(`## 用户选中的代码\n\n\`\`\`\n${truncatedCode}\n\`\`\``);
  }

  // 添加当前文件信息（如果有）
  if (context?.currentFile?.path) {
    let fileInfo = `## 当前文件\n\n路径: ${context.currentFile.path}`;
    if (context.currentFile.language) {
      fileInfo += `\n语言: ${context.currentFile.language}`;
    }
    contextParts.push(fileInfo);
  }

  // 添加光标位置信息（如果有）
  if (context?.cursorPosition) {
    const pos = context.cursorPosition;
    let cursorInfo = `## 光标位置\n\n第 ${pos.line} 行，第 ${pos.column} 列`;
    if (context.cursorContext) {
      const truncatedContext = truncateText(context.cursorContext, MAX_CURSOR_CONTEXT_LENGTH);
      cursorInfo += `\n\n光标周围代码:\n\`\`\`\n${truncatedContext}\n\`\`\``;
    }
    contextParts.push(cursorInfo);
  }

  // 构建完整提示词
  let fullPrompt = `## 用户原始提示词\n\n${originalPrompt}`;

  if (contextParts.length > 0) {
    fullPrompt += '\n\n---\n\n# 上下文信息\n\n' + contextParts.join('\n\n');
  }

  return fullPrompt;
}

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
 * @param {number} aceProxyPort - ACE 代理服务端口（可选，由 Java 端传入）
 * @returns {Promise<string>} - 增强后的提示词
 */
async function enhancePrompt(originalPrompt, systemPrompt, model, context, aceProxyPort) {
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
    const workingDirectory = homedir();

    // 尝试使用 ACE MCP 获取上下文
    console.log('[PromptEnhancer] ========== ACE MCP 检测开始 ==========');
    let fullPrompt;
    const aceStatus = checkAceMcpAvailability();

    if (aceStatus.available) {
      console.log('[PromptEnhancer] [ACE] ACE MCP 可用! 服务器: ' + aceStatus.serverName);
      console.log('[PromptEnhancer] [ACE] 尝试获取上下文...');

      // 从当前文件路径提取项目路径
      let projectPath = null;
      if (context?.currentFile?.path) {
        // 尝试找到项目根目录（包含 .git, pom.xml, package.json 等的目录）
        const { dirname, join: pathJoin } = await import('path');
        const { existsSync } = await import('fs');

        let currentDir = dirname(context.currentFile.path);
        const projectMarkers = ['.git', 'pom.xml', 'build.gradle', 'package.json', '.project'];

        // 向上查找项目根目录
        while (currentDir && currentDir !== '/' && currentDir !== dirname(currentDir)) {
          for (const marker of projectMarkers) {
            if (existsSync(pathJoin(currentDir, marker))) {
              projectPath = currentDir;
              break;
            }
          }
          if (projectPath) break;
          currentDir = dirname(currentDir);
        }

        console.log(`[PromptEnhancer] [ACE] 检测到项目路径: ${projectPath || '未找到'}`);
      }

      // 构建 ACE 检索请求
      const aceRequest = `用户正在编写代码，需要帮助完成以下任务：${originalPrompt}
${context?.currentFile?.path ? `\n当前文件: ${context.currentFile.path}` : ''}
${context?.selectedCode ? `\n用户选中了一段代码` : ''}
请检索与此任务相关的代码上下文。`;

      // 如果有代理端口，优先使用代理服务
      if (aceProxyPort && aceProxyPort > 0) {
        console.log(`[PromptEnhancer] [ACE] 使用 Java 端提供的代理端口: ${aceProxyPort}`);
      }

      const aceContext = await getAceContext(aceRequest, aceStatus.serverConfig, aceStatus.serverName, projectPath, aceProxyPort);

      if (aceContext) {
        console.log('[PromptEnhancer] [ACE] ★★★ ACE 上下文获取成功! 使用 ACE 增强模式 ★★★');
        fullPrompt = buildFullPromptWithAce(originalPrompt, context, aceContext);
      } else {
        console.log('[PromptEnhancer] [ACE] ACE 上下文获取失败，回退到默认模式');
        fullPrompt = buildFullPrompt(originalPrompt, context);
      }
    } else {
      console.log('[PromptEnhancer] [ACE] ACE MCP 不可用，使用默认模式');
      fullPrompt = buildFullPrompt(originalPrompt, context);
    }
    console.log('[PromptEnhancer] ========== ACE MCP 检测结束 ==========');

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
 * 解析命令行参数
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { aceProxyPort: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ace-proxy-port' && args[i + 1]) {
      result.aceProxyPort = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return result;
}

/**
 * 主函数
 */
async function main() {
  try {
    // 解析命令行参数
    const cmdArgs = parseArgs();

    // 读取 stdin 输入
    const input = await readStdin();
    const data = JSON.parse(input);

    const { prompt, systemPrompt, model, context } = data;

    // 从输入数据或命令行参数获取代理端口
    const aceProxyPort = data.aceProxyPort || cmdArgs.aceProxyPort;

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

    // 记录 ACE 代理端口
    if (aceProxyPort) {
      console.log(`[PromptEnhancer] ACE 代理端口: ${aceProxyPort}`);
    }

    // 增强提示词（传递上下文信息和代理端口）
    const enhancedPrompt = await enhancePrompt(prompt, systemPrompt, model, context, aceProxyPort);

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
