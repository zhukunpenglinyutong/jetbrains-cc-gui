#!/usr/bin/env node

/**
 * Claude Agent Channel Manager V2
 * 支持持久化 channel 的多轮对话（简化版）
 *
 * 命令:
 *   send <message> [sessionId] [cwd] - 发送消息（如果有 sessionId 则恢复会话）
 *   getSession <sessionId> [cwd] - 获取会话历史消息
 *
 * 设计说明：
 * - 不维护全局状态（每次调用是独立进程）
 * - sessionId 由调用方（Java）维护
 * - 每次调用时通过 resume 参数恢复会话
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import fs from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { readFile } from 'fs/promises';
import { canUseTool } from './permission-handler.js';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

/**
 * AsyncStream - 手动控制的异步迭代器
 * 用于向 Claude Agent SDK 传递用户消息（包括图片）
 */
class AsyncStream {
  constructor() {
    this.queue = [];
    this.readResolve = undefined;
    this.isDone = false;
    this.started = false;
  }

  [Symbol.asyncIterator]() {
    if (this.started) {
      throw new Error("Stream can only be iterated once");
    }
    this.started = true;
    return this;
  }

  async next() {
    if (this.queue.length > 0) {
      return { done: false, value: this.queue.shift() };
    }
    if (this.isDone) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => {
      this.readResolve = resolve;
    });
  }

  enqueue(value) {
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  done() {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  async return() {
    this.isDone = true;
    return { done: true, value: undefined };
  }
}

// 读取 Claude Code 配置
function loadClaudeSettings() {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return settings;
  } catch (error) {
    return null;
  }
}

// 配置 API Key
function setupApiKey() {
  const settings = loadClaudeSettings();

  let apiKey;
  let baseUrl;
  let apiKeySource = 'default';
  let baseUrlSource = 'default';

  // 优先级：settings.json > 环境变量
  if (settings?.env?.ANTHROPIC_API_KEY) {
    apiKey = settings.env.ANTHROPIC_API_KEY;
    apiKeySource = 'settings.json';
  } else if (settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
    apiKeySource = 'settings.json';
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    apiKeySource = 'environment';
  }

  if (settings?.env?.ANTHROPIC_BASE_URL) {
    baseUrl = settings.env.ANTHROPIC_BASE_URL;
    baseUrlSource = 'settings.json';
  } else if (process.env.ANTHROPIC_BASE_URL) {
    baseUrl = process.env.ANTHROPIC_BASE_URL;
    baseUrlSource = 'environment';
  }

  if (!apiKey) {
    console.error('[ERROR] API Key not configured. Please set ANTHROPIC_API_KEY in environment or ~/.claude/settings.json');
    throw new Error('API Key not configured');
  }

  process.env.ANTHROPIC_API_KEY = apiKey;
  if (baseUrl) {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
  }

  return { apiKey, baseUrl, apiKeySource, baseUrlSource };
}

/**
 * 获取系统临时目录前缀列表
 * 支持 Windows、macOS 和 Linux
 */
function getTempPathPrefixes() {
  const prefixes = [];

  // 1. 使用 os.tmpdir() 获取系统临时目录
  const systemTempDir = tmpdir();
  if (systemTempDir) {
    prefixes.push(normalizePathForComparison(systemTempDir));
  }

  // 2. Windows 特定环境变量
  if (process.platform === 'win32') {
    const winTempVars = ['TEMP', 'TMP', 'LOCALAPPDATA'];
    for (const varName of winTempVars) {
      const value = process.env[varName];
      if (value) {
        prefixes.push(normalizePathForComparison(value));
        // Windows Temp 通常在 LOCALAPPDATA\Temp
        if (varName === 'LOCALAPPDATA') {
          prefixes.push(normalizePathForComparison(join(value, 'Temp')));
        }
      }
    }
    // Windows 默认临时路径
    prefixes.push('c:\\windows\\temp');
    prefixes.push('c:\\temp');
  } else {
    // Unix/macOS 临时路径前缀
    prefixes.push('/tmp');
    prefixes.push('/var/tmp');
    prefixes.push('/private/tmp');

    // 环境变量
    if (process.env.TMPDIR) {
      prefixes.push(normalizePathForComparison(process.env.TMPDIR));
    }
  }

  // 去重
  return [...new Set(prefixes)];
}

/**
 * 规范化路径用于比较
 * Windows: 转小写，使用正斜杠
 */
function normalizePathForComparison(pathValue) {
  if (!pathValue) return '';
  let normalized = pathValue.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function sanitizePath(candidate) {
  if (!candidate || typeof candidate !== 'string' || candidate.trim() === '') {
    return null;
  }
  try {
    return resolve(candidate.trim());
  } catch {
    return null;
  }
}

function isTempDirectory(pathValue) {
  if (!pathValue) return false;

  const normalizedPath = normalizePathForComparison(pathValue);
  const tempPrefixes = getTempPathPrefixes();

  return tempPrefixes.some(tempPath => {
    if (!tempPath) return false;
    return normalizedPath.startsWith(tempPath) ||
           normalizedPath === tempPath;
  });
}

function selectWorkingDirectory(requestedCwd) {
  const candidates = [];

  const envProjectPath = process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH;

  if (requestedCwd && requestedCwd !== 'undefined' && requestedCwd !== 'null') {
    candidates.push(requestedCwd);
  }
  if (envProjectPath) {
    candidates.push(envProjectPath);
  }

  candidates.push(process.cwd());
  candidates.push(homedir());

  console.log('[DEBUG] selectWorkingDirectory candidates:', JSON.stringify(candidates));

  for (const candidate of candidates) {
    const normalized = sanitizePath(candidate);
    if (!normalized) continue;

    if (isTempDirectory(normalized) && envProjectPath) {
      console.log('[DEBUG] Skipping temp directory candidate:', normalized);
      continue;
    }

    try {
      const stats = fs.statSync(normalized);
      if (stats.isDirectory()) {
        console.log('[DEBUG] selectWorkingDirectory resolved:', normalized);
        return normalized;
      }
    } catch {
      // Ignore invalid candidates
      console.log('[DEBUG] Candidate is invalid:', normalized);
    }
  }

  console.log('[DEBUG] selectWorkingDirectory fallback triggered');
  return envProjectPath || homedir();
}

/**
 * 将完整的模型 ID 映射为 Claude SDK 期望的简短名称
 * @param {string} modelId - 完整的模型 ID（如 'claude-sonnet-4-5'）
 * @returns {string} SDK 期望的模型名称（如 'sonnet'）
 */
function mapModelIdToSdkName(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return 'sonnet'; // 默认使用 sonnet
  }

  const lowerModel = modelId.toLowerCase();

  // 映射规则：
  // - 包含 'opus' -> 'opus'
  // - 包含 'haiku' -> 'haiku'
  // - 其他情况（包含 'sonnet' 或未知）-> 'sonnet'
  if (lowerModel.includes('opus')) {
    return 'opus';
  } else if (lowerModel.includes('haiku')) {
    return 'haiku';
  } else {
    return 'sonnet';
  }
}

/**
 * 检测是否使用自定义 Base URL（非官方 Anthropic API）
 * @param {string} baseUrl - Base URL
 * @returns {boolean} 是否为自定义 URL
 */
function isCustomBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  const officialUrls = [
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'api.anthropic.com'
  ];
  return !officialUrls.some(url => baseUrl.toLowerCase().includes('api.anthropic.com'));
}

/**
 * 发送消息（支持会话恢复）
 * @param {string} message - 要发送的消息
 * @param {string} resumeSessionId - 要恢复的会话ID
 * @param {string} cwd - 工作目录
 * @param {string} permissionMode - 权限模式（可选）
 * @param {string} model - 模型名称（可选）
 */
async function sendMessage(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null) {
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';
    console.log('[DEBUG] CLAUDE_CODE_ENTRYPOINT:', process.env.CLAUDE_CODE_ENTRYPOINT);

    // 设置 API Key 并获取配置信息
    const { apiKey, baseUrl, apiKeySource, baseUrlSource } = setupApiKey();

    // 检测是否使用自定义 Base URL
    // 注意：不再使用 Anthropic SDK 回退，因为第三方代理服务 (如 88code.org)
    // 只支持 Claude Code 协议，不支持标准的 Anthropic Messages API。
    // 我们使用系统安装的 Claude CLI (通过 pathToClaudeCodeExecutable 选项)，
    // 它会读取 ~/.claude/settings.json 中的配置并正确调用代理服务。
    if (isCustomBaseUrl(baseUrl)) {
      console.log('[DEBUG] Custom Base URL detected:', baseUrl);
      console.log('[DEBUG] Will use system Claude CLI (not Anthropic SDK fallback)');
    }

    console.log('[DEBUG] sendMessage called with params:', {
      resumeSessionId,
      cwd,
      permissionMode,
      model,
      IDEA_PROJECT_PATH: process.env.IDEA_PROJECT_PATH,
      PROJECT_PATH: process.env.PROJECT_PATH
    });

    console.log('[DEBUG] API Key loaded:', apiKey ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 5)}` : 'NOT SET');
    console.log('[DEBUG] API Key source:', apiKeySource);
    console.log('[DEBUG] Base URL:', baseUrl || 'https://api.anthropic.com');
    console.log('[DEBUG] Base URL source:', baseUrlSource);

    console.log('[MESSAGE_START]');
    console.log('[DEBUG] Calling query() with prompt:', message);

    // 智能确定工作目录
    const workingDirectory = selectWorkingDirectory(cwd);

    console.log('[DEBUG] process.cwd() before chdir:', process.cwd());
    try {
      process.chdir(workingDirectory);
      console.log('[DEBUG] Using working directory:', workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }
    console.log('[DEBUG] process.cwd() after chdir:', process.cwd());

    // 注释掉错误的临时目录设置 - 这会导致 Claude SDK 在项目目录创建临时文件
    // process.env.TMPDIR = workingDirectory;
    // process.env.TEMP = workingDirectory;
    // process.env.TMP = workingDirectory;

    // 使用系统默认的临时目录，或者创建一个专门的临时目录
    const systemTmpDir = tmpdir();
    console.log('[DEBUG] Using system temp directory:', systemTmpDir);

    // 将模型 ID 映射为 SDK 期望的名称
    const sdkModelName = mapModelIdToSdkName(model);
    console.log('[DEBUG] Model mapping:', model, '->', sdkModelName);

    // 获取系统安装的 Claude CLI 路径
    const getClaudeCliPath = () => {
      try {
        // 先尝试 which 命令（macOS/Linux）
        const whichResult = execSync('which claude', { encoding: 'utf-8' }).trim();
        if (whichResult && existsSync(whichResult)) {
          console.log('[DEBUG] Found Claude CLI via which:', whichResult);
          return whichResult;
        }
      } catch (e) {
        console.log('[DEBUG] which claude failed:', e.message);
      }

      try {
        // Windows: 尝试 where 命令
        const whereResult = execSync('where claude', { encoding: 'utf-8' }).trim().split('\n')[0];
        if (whereResult && existsSync(whereResult)) {
          console.log('[DEBUG] Found Claude CLI via where:', whereResult);
          return whereResult;
        }
      } catch (e) {
        console.log('[DEBUG] where claude failed:', e.message);
      }

      // 常见安装路径
      const commonPaths = [
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        `${process.env.HOME}/.nvm/versions/node/v24.11.1/bin/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        'C:\\Program Files\\Claude\\claude.exe',
        'C:\\Users\\' + (process.env.USERNAME || '') + '\\AppData\\Local\\Programs\\Claude\\claude.exe'
      ];

      for (const p of commonPaths) {
        if (existsSync(p)) {
          console.log('[DEBUG] Found Claude CLI at common path:', p);
          return p;
        }
      }

      console.log('[DEBUG] Claude CLI not found, using SDK default');
      return undefined;
    };

    const claudeCliPath = getClaudeCliPath();

    // 准备选项
    const options = {
      cwd: workingDirectory,
      permissionMode: permissionMode || 'default', // 使用传入的权限模式，如果没有则默认
      model: sdkModelName, // 使用映射后的模型名称
      maxTurns: 100,
      additionalDirectories: Array.from(
        new Set(
          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
        )
      ),
      // 添加 canUseTool 回调来处理权限请求
      canUseTool: permissionMode === 'default' ? canUseTool : undefined,
      // 使用系统安装的 Claude CLI 而不是 SDK 内置的
      pathToClaudeCodeExecutable: claudeCliPath,
      // 配置来源：user = ~/.claude/settings.json (API 密钥等)
      settingSources: ['user', 'project', 'local']
    };

    if (claudeCliPath) {
      console.log('[DEBUG] Using system Claude CLI:', claudeCliPath);
    } else {
      console.log('[DEBUG] Using SDK built-in Claude CLI');
    }

    console.log('[DEBUG] Options:', JSON.stringify(options, null, 2));

    // 如果有 sessionId 且不为空字符串，使用 resume 恢复会话
    if (resumeSessionId && resumeSessionId !== '') {
      options.resume = resumeSessionId;
      console.log('[RESUMING]', resumeSessionId);
    }

    console.log('[DEBUG] Query started, waiting for messages...');

    // 调用 query 函数，添加超时处理
    let queryTimeoutId;
    const queryPromise = query({
      prompt: message,
      options: options
    });

    // 设置60秒超时（与Java端一致）
    const timeoutPromise = new Promise((_, reject) => {
      queryTimeoutId = setTimeout(() => {
        console.log('[DEBUG] Query timeout after 60 seconds');
        reject(new Error('Claude Code process aborted by user'));
      }, 60000);
    });

    // 等待 query 完成或超时
    const result = await Promise.race([queryPromise, timeoutPromise])
      .finally(() => {
        if (queryTimeoutId) clearTimeout(queryTimeoutId);
      });

    console.log('[DEBUG] Starting message loop...');

    let currentSessionId = resumeSessionId;

    // 流式输出
    let messageCount = 0;
    for await (const msg of result) {
      messageCount++;
      console.log(`[DEBUG] Received message #${messageCount}, type: ${msg.type}`);

      // 输出原始消息（方便 Java 解析）
      console.log('[MESSAGE]', JSON.stringify(msg));

      // 实时输出助手内容
      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log('[CONTENT]', block.text);
            } else if (block.type === 'tool_use') {
              console.log('[DEBUG] Tool use payload:', JSON.stringify(block));
            }
          }
        } else if (typeof content === 'string') {
          console.log('[CONTENT]', content);
        }
      }

      // 捕获并保存 session_id
      if (msg.type === 'system' && msg.session_id) {
        currentSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);
      }
    }

    console.log(`[DEBUG] Message loop completed. Total messages: ${messageCount}`);

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      sessionId: currentSessionId
    }));

  } catch (error) {
    console.error('[SEND_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  }
}

/**
 * 使用 Anthropic SDK 发送消息（用于第三方 API 代理的回退方案）
 * 当检测到使用自定义 Base URL 时，Claude Agent SDK 可能不兼容，使用此函数
 * 注意：使用非流式 API，因为第三方代理可能不支持 SSE 流式传输
 */
async function sendMessageWithAnthropicSDK(message, resumeSessionId, cwd, permissionMode, model, apiKey, baseUrl) {
  try {
    const workingDirectory = selectWorkingDirectory(cwd);
    try { process.chdir(workingDirectory); } catch {}

    const sessionId = (resumeSessionId && resumeSessionId !== '') ? resumeSessionId : randomUUID();

    // 使用完整的模型 ID（Anthropic SDK 需要完整名称）
    const modelId = model || 'claude-sonnet-4-5';

    const client = new Anthropic({ apiKey, baseURL: baseUrl || undefined });

    console.log('[MESSAGE_START]');
    console.log('[SESSION_ID]', sessionId);
    console.log('[DEBUG] Using Anthropic SDK fallback for custom Base URL (non-streaming)');
    console.log('[DEBUG] Model:', modelId);
    console.log('[DEBUG] Base URL:', baseUrl);

    // 构建用户消息内容
    const userContent = [{ type: 'text', text: message }];

    // 持久化用户消息到 JSONL
    persistJsonlMessage(sessionId, cwd, {
      type: 'user',
      message: { content: userContent }
    });

    // 加载历史消息以维护会话上下文（如果是恢复会话）
    let messagesForApi = [{ role: 'user', content: userContent }];
    if (resumeSessionId && resumeSessionId !== '') {
      const historyMessages = loadSessionHistory(sessionId, cwd);
      if (historyMessages.length > 0) {
        messagesForApi = [...historyMessages, { role: 'user', content: userContent }];
        console.log('[DEBUG] Loaded', historyMessages.length, 'history messages for session continuity');
      }
    }

    // 输出 system 消息（模拟 Claude Agent SDK 的格式）
    const systemMsg = {
      type: 'system',
      subtype: 'init',
      cwd: workingDirectory,
      session_id: sessionId,
      tools: [],
      mcp_servers: [],
      model: modelId,
      permissionMode: permissionMode || 'default',
      apiKeySource: 'ANTHROPIC_API_KEY',
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(systemMsg));

    // 使用非流式 API（第三方代理可能不支持 SSE 流式传输）
    console.log('[DEBUG] Calling messages.create() with non-streaming API...');
    console.log('[DEBUG] Request payload:', JSON.stringify({
      model: modelId,
      max_tokens: 8192,
      messages: messagesForApi
    }, null, 2));

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 8192,
      messages: messagesForApi
    });

    // 打印完整的原始响应，用于调试
    console.log('[DEBUG] API response received');
    console.log('[DEBUG] Raw response:', JSON.stringify(response, null, 2));

    // 检查响应结构
    console.log('[DEBUG] Response keys:', Object.keys(response));
    console.log('[DEBUG] Response.content:', JSON.stringify(response.content));
    console.log('[DEBUG] Response.usage:', JSON.stringify(response.usage));

    // 检查是否是错误响应
    if (response.error || response.type === 'error') {
      const errorMsg = response.error?.message || response.message || 'Unknown API error';
      const errorType = response.error?.type || response.type || 'error';
      console.error('[API_ERROR]', errorType + ':', errorMsg);

      // 构建错误内容作为助手消息显示给用户
      const errorContent = [{
        type: 'text',
        text: `API 错误: ${errorMsg}\n\n可能的原因:\n1. API Key 配置不正确\n2. 第三方代理服务配置问题\n3. 请检查 ~/.claude/settings.json 中的配置`
      }];

      // 输出助手消息（显示错误信息）
      const assistantMsg = {
        type: 'assistant',
        message: {
          id: randomUUID(),
          model: modelId,
          role: 'assistant',
          stop_reason: 'error',
          type: 'message',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: errorContent
        },
        session_id: sessionId,
        uuid: randomUUID()
      };
      console.log('[MESSAGE]', JSON.stringify(assistantMsg));
      console.log('[CONTENT]', errorContent[0].text);

      // 输出 result 消息
      const resultMsg = {
        type: 'result',
        subtype: 'error',
        is_error: true,
        duration_ms: 0,
        num_turns: 1,
        result: errorContent[0].text,
        session_id: sessionId,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: randomUUID()
      };
      console.log('[MESSAGE]', JSON.stringify(resultMsg));
      console.log('[MESSAGE_END]');
      console.log(JSON.stringify({ success: false, error: errorMsg }));
      return;
    }

    const respContent = response.content || [];
    const usage = response.usage || {};

    // 输出助手消息（模拟 Claude Agent SDK 的格式）
    const assistantMsg = {
      type: 'assistant',
      message: {
        id: response.id || randomUUID(),
        model: response.model || modelId,
        role: 'assistant',
        stop_reason: response.stop_reason || 'end_turn',
        type: 'message',
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        content: respContent
      },
      session_id: sessionId,
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(assistantMsg));

    // 持久化助手消息到 JSONL
    persistJsonlMessage(sessionId, cwd, {
      type: 'assistant',
      message: { content: respContent }
    });

    // 输出内容
    for (const block of respContent) {
      if (block.type === 'text') {
        console.log('[CONTENT]', block.text);
      }
    }

    // 输出 result 消息（模拟 Claude Agent SDK 的格式）
    const resultMsg = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 0,
      num_turns: 1,
      result: respContent.map(b => b.type === 'text' ? b.text : '').join(''),
      session_id: sessionId,
      total_cost_usd: 0,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(resultMsg));

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({ success: true, sessionId }));

  } catch (error) {
    console.error('[SEND_ERROR]', error.message);
    // 输出更详细的错误信息以帮助调试
    if (error.response) {
      console.error('[ERROR_DETAILS] Status:', error.response.status);
      console.error('[ERROR_DETAILS] Data:', JSON.stringify(error.response.data));
    }
    console.log(JSON.stringify({ success: false, error: error.message }));
  }
}

/**
 * 读取附件 JSON（通过环境变量 CLAUDE_ATTACHMENTS_FILE 指定路径）
 * @deprecated 使用 loadAttachmentsFromStdin 替代，避免文件 I/O
 */
function loadAttachmentsFromEnv() {
  try {
    const filePath = process.env.CLAUDE_ATTACHMENTS_FILE;
    if (!filePath) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (e) {
    console.error('[ATTACHMENTS] Failed to load attachments:', e.message);
    return [];
  }
}

/**
 * 从 stdin 读取附件数据（异步）
 * Java 端通过 stdin 发送 JSON 格式的附件数组，避免临时文件
 * 格式: { "attachments": [...], "message": "用户消息" }
 */
async function readStdinData() {
  return new Promise((resolve) => {
    // 检查是否有环境变量标记表示使用 stdin
    if (process.env.CLAUDE_USE_STDIN !== 'true') {
      resolve(null);
      return;
    }

    let data = '';
    const timeout = setTimeout(() => {
      console.log('[DEBUG] stdin read timeout, no data received');
      resolve(null);
    }, 5000); // 5秒超时

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      if (data.trim()) {
        try {
          const parsed = JSON.parse(data);
          console.log('[DEBUG] Successfully read stdin data, keys:', Object.keys(parsed));
          resolve(parsed);
        } catch (e) {
          console.error('[STDIN] Failed to parse stdin JSON:', e.message);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[STDIN] Error reading stdin:', err.message);
      resolve(null);
    });

    // 开始读取
    process.stdin.resume();
  });
}

/**
 * 从 stdin 或环境变量文件加载附件（兼容两种方式）
 * 优先使用 stdin，如果没有则回退到文件方式
 *
 * 支持的 stdinData 格式：
 * 1. 直接数组格式: [{fileName, mediaType, data}, ...]
 * 2. 包装对象格式: { attachments: [...] }
 */
async function loadAttachments(stdinData) {
  // 优先使用 stdin 传入的数据
  if (stdinData) {
    // 格式1: 直接数组格式 (Java 端发送)
    if (Array.isArray(stdinData)) {
      console.log('[DEBUG] Using attachments from stdin (array format), count:', stdinData.length);
      return stdinData;
    }
    // 格式2: 包装对象格式
    if (Array.isArray(stdinData.attachments)) {
      console.log('[DEBUG] Using attachments from stdin (wrapped format), count:', stdinData.attachments.length);
      return stdinData.attachments;
    }
  }

  // 回退到文件方式（兼容旧版本）
  console.log('[DEBUG] Falling back to file-based attachments');
  return loadAttachmentsFromEnv();
}

/**
 * 将一条消息追加到 JSONL 历史文件
 * 添加必要的元数据字段以确保与历史记录读取器兼容
 */
function persistJsonlMessage(sessionId, cwd, obj) {
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    const sanitizedCwd = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
    const projectHistoryDir = join(projectsDir, sanitizedCwd);
    fs.mkdirSync(projectHistoryDir, { recursive: true });
    const sessionFile = join(projectHistoryDir, `${sessionId}.jsonl`);

    // 添加必要的元数据字段以确保与 ClaudeHistoryReader 兼容
    const enrichedObj = {
      ...obj,
      uuid: randomUUID(),
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    };

    fs.appendFileSync(sessionFile, JSON.stringify(enrichedObj) + '\n', 'utf8');
    console.log('[PERSIST] Message saved to:', sessionFile);
  } catch (e) {
    console.error('[PERSIST_ERROR]', e.message);
  }
}

/**
 * 加载会话历史消息（用于恢复会话时维护上下文）
 * 返回 Anthropic Messages API 格式的消息数组
 */
function loadSessionHistory(sessionId, cwd) {
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    const sanitizedCwd = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
    const sessionFile = join(projectsDir, sanitizedCwd, `${sessionId}.jsonl`);

    if (!fs.existsSync(sessionFile)) {
      return [];
    }

    const content = fs.readFileSync(sessionFile, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'user' && msg.message && msg.message.content) {
          messages.push({
            role: 'user',
            content: msg.message.content
          });
        } else if (msg.type === 'assistant' && msg.message && msg.message.content) {
          messages.push({
            role: 'assistant',
            content: msg.message.content
          });
        }
      } catch (e) {
        // 跳过解析失败的行
      }
    }

    // 排除最后一条用户消息（因为我们在调用此函数前已经持久化了当前用户消息）
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      messages.pop();
    }

    return messages;
  } catch (e) {
    console.error('[LOAD_HISTORY_ERROR]', e.message);
    return [];
  }
}

/**
 * 使用 Claude Agent SDK 发送带附件的消息（多模态）
 * 通过 AsyncStream + SDKUserMessage 格式传递图片，与 sendMessage 使用相同的 Claude CLI 通道
 * 这样可以兼容 88code 等只支持 Claude Code 协议的第三方 API
 */
async function sendMessageWithAttachments(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, stdinData = null) {
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key 并获取配置信息
    const { baseUrl, apiKeySource, baseUrlSource } = setupApiKey();

    console.log('[DEBUG] ============================================');
    console.log('[DEBUG] sendMessageWithAttachments called (using Claude Agent SDK)');
    console.log('[DEBUG] Base URL:', baseUrl || 'https://api.anthropic.com (default)');
    console.log('[DEBUG] Is custom Base URL:', isCustomBaseUrl(baseUrl));
    console.log('[DEBUG] Model:', model);
    console.log('[DEBUG] Session ID:', resumeSessionId);
    console.log('[DEBUG] API Key source:', apiKeySource);
    console.log('[DEBUG] Base URL source:', baseUrlSource);
    console.log('[DEBUG] stdin data provided:', stdinData ? 'yes' : 'no');
    console.log('[DEBUG] ============================================');

    console.log('[MESSAGE_START]');

    // 智能确定工作目录
    const workingDirectory = selectWorkingDirectory(cwd);
    console.log('[DEBUG] process.cwd() before chdir:', process.cwd());
    try {
      process.chdir(workingDirectory);
      console.log('[DEBUG] Using working directory:', workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // 加载附件（优先使用 stdin 传入的数据，避免文件 I/O）
    const attachments = await loadAttachments(stdinData);
    console.log('[DEBUG] Loaded attachments count:', attachments.length);

    // 构建用户消息内容块（与 claude-code-cn 相同的格式）
    const contentBlocks = [];

    // 添加图片块
    for (const a of attachments) {
      const mt = typeof a.mediaType === 'string' ? a.mediaType : '';
      if (mt.startsWith('image/')) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mt || 'image/png',
            data: a.data
          }
        });
        console.log('[DEBUG] Added image block, media_type:', mt);
      } else {
        // 非图片附件作为文本提示
        const name = a.fileName || '附件';
        contentBlocks.push({ type: 'text', text: `[附件: ${name}]` });
        console.log('[DEBUG] Added text block for non-image attachment:', name);
      }
    }

    // 处理空消息情况
    let userText = message;
    if (!userText || userText.trim() === '') {
      const imageCount = contentBlocks.filter(b => b.type === 'image').length;
      const textCount = contentBlocks.filter(b => b.type === 'text').length;
      if (imageCount > 0) {
        userText = `[已上传 ${imageCount} 张图片]`;
      } else if (textCount > 0) {
        userText = `[已上传附件]`;
      } else {
        userText = '[空消息]';
      }
      console.log('[DEBUG] Empty message replaced with:', userText);
    }

    // 添加用户文本
    contentBlocks.push({ type: 'text', text: userText });

    // 构建 SDKUserMessage 格式
    const userMessage = {
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: contentBlocks
      }
    };

    console.log('[DEBUG] Built SDKUserMessage with content blocks:', contentBlocks.map(b => b.type));

    // 将模型 ID 映射为 SDK 期望的名称
    const sdkModelName = mapModelIdToSdkName(model);
    console.log('[DEBUG] Model mapping:', model, '->', sdkModelName);

    // 获取系统安装的 Claude CLI 路径
    const getClaudeCliPath = () => {
      try {
        const whichResult = execSync('which claude', { encoding: 'utf-8' }).trim();
        if (whichResult && existsSync(whichResult)) {
          return whichResult;
        }
      } catch (e) {}

      try {
        const whereResult = execSync('where claude', { encoding: 'utf-8' }).trim().split('\n')[0];
        if (whereResult && existsSync(whereResult)) {
          return whereResult;
        }
      } catch (e) {}

      const commonPaths = [
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        `${process.env.HOME}/.nvm/versions/node/v24.11.1/bin/claude`,
        `${process.env.HOME}/.local/bin/claude`,
      ];

      for (const p of commonPaths) {
        if (existsSync(p)) {
          return p;
        }
      }

      return undefined;
    };

    const claudeCliPath = getClaudeCliPath();
    console.log('[DEBUG] Claude CLI path:', claudeCliPath || 'SDK default');

    // 创建输入流并放入用户消息
    const inputStream = new AsyncStream();
    inputStream.enqueue(userMessage);
    inputStream.done();

    // 准备选项
    const options = {
      cwd: workingDirectory,
      permissionMode: permissionMode || 'default',
      model: sdkModelName,
      maxTurns: 100,
      additionalDirectories: Array.from(
        new Set(
          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
        )
      ),
      canUseTool: permissionMode === 'default' ? canUseTool : undefined,
      pathToClaudeCodeExecutable: claudeCliPath,
      settingSources: ['user', 'project', 'local']
    };

    // 如果有 sessionId，使用 resume 恢复会话
    if (resumeSessionId && resumeSessionId !== '') {
      options.resume = resumeSessionId;
      console.log('[RESUMING]', resumeSessionId);
    }

    console.log('[DEBUG] Options:', JSON.stringify({ ...options, canUseTool: options.canUseTool ? '[Function]' : undefined }, null, 2));
    console.log('[DEBUG] Calling query() with inputStream...');

    // 调用 query 函数
    let queryTimeoutId;
    const queryPromise = query({
      prompt: inputStream,
      options: options
    });

    // 设置60秒超时
    const timeoutPromise = new Promise((_, reject) => {
      queryTimeoutId = setTimeout(() => {
        console.log('[DEBUG] Query timeout after 60 seconds');
        reject(new Error('Claude Code process aborted by user'));
      }, 60000);
    });

    const result = await Promise.race([queryPromise, timeoutPromise])
      .finally(() => {
        if (queryTimeoutId) clearTimeout(queryTimeoutId);
      });

    console.log('[DEBUG] Starting message loop...');

    let currentSessionId = resumeSessionId;
    let messageCount = 0;

    // 流式输出
    for await (const msg of result) {
      messageCount++;
      console.log(`[DEBUG] Received message #${messageCount}, type: ${msg.type}`);

      // 输出原始消息（方便 Java 解析）
      console.log('[MESSAGE]', JSON.stringify(msg));

      // 实时输出助手内容
      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log('[CONTENT]', block.text);
            } else if (block.type === 'tool_use') {
              console.log('[DEBUG] Tool use payload:', JSON.stringify(block));
            }
          }
        } else if (typeof content === 'string') {
          console.log('[CONTENT]', content);
        }
      }

      // 捕获并保存 session_id
      if (msg.type === 'system' && msg.session_id) {
        currentSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);
      }
    }

    console.log(`[DEBUG] Message loop completed. Total messages: ${messageCount}`);

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      sessionId: currentSessionId
    }));

  } catch (error) {
    console.error('[DEBUG] ============================================');
    console.error('[DEBUG] sendMessageWithAttachments FAILED!');
    console.error('[SEND_ERROR]', error.message);
    console.error('[DEBUG] Error name:', error.name);
    console.error('[DEBUG] Error stack:', error.stack);
    console.error('[DEBUG] ============================================');
    console.log(JSON.stringify({ success: false, error: error.message }));
  }
}

/**
 * 获取会话历史消息
 * 从 ~/.claude/projects/ 目录读取
 */
async function getSessionMessages(sessionId, cwd = null) {
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');

    // 转义项目路径（与 ClaudeSessionService.ts 相同逻辑）
    const sanitizedCwd = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
    const projectHistoryDir = join(projectsDir, sanitizedCwd);

    // 会话文件路径
    const sessionFile = join(projectHistoryDir, `${sessionId}.jsonl`);

    if (!existsSync(sessionFile)) {
      console.log(JSON.stringify({
        success: false,
        error: 'Session file not found'
      }));
      return;
    }

    // 读取 JSONL 文件
    const content = await readFile(sessionFile, 'utf8');
    const messages = content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(msg => msg !== null);

    console.log(JSON.stringify({
      success: true,
      messages
    }));

  } catch (error) {
    console.error('[GET_SESSION_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  }
}

// 命令行参数解析
const command = process.argv[2];
const args = process.argv.slice(3);

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_ERROR]', error.message);
  console.log(JSON.stringify({
    success: false,
    error: error.message
  }));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
  console.log(JSON.stringify({
    success: false,
    error: String(reason)
  }));
  process.exit(1);
});

// 执行命令
(async () => {
  try {
    switch (command) {
      case 'send':
        // send <message> [sessionId] [cwd] [permissionMode] [model]
        await sendMessage(args[0], args[1], args[2], args[3], args[4]);
        break;

      case 'sendWithAttachments':
        // sendWithAttachments <message> [sessionId] [cwd] [permissionMode] [model]
        // 先尝试从 stdin 读取附件数据（如果设置了 CLAUDE_USE_STDIN=true）
        const stdinData = await readStdinData();
        await sendMessageWithAttachments(args[0], args[1], args[2], args[3], args[4], stdinData);
        break;

      case 'getSession':
        // getSession <sessionId> [cwd]
        await getSessionMessages(args[0], args[1]);
        break;

      default:
        console.error('Unknown command:', command);
        console.log(JSON.stringify({
          success: false,
          error: 'Unknown command: ' + command
        }));
        process.exit(1);
    }
  } catch (error) {
    console.error('[COMMAND_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
})();
