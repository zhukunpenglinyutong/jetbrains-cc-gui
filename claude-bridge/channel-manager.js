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
import { readFileSync, existsSync, statSync } from 'fs';
import fs from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { readFile } from 'fs/promises';
import { canUseTool } from './permission-handler.js';

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

const TEMP_PATH_PREFIXES = ['/tmp', '/var/tmp', '/private/tmp'];

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
  const dynamicTemp = process.env.TMPDIR ? [...TEMP_PATH_PREFIXES, process.env.TMPDIR] : TEMP_PATH_PREFIXES;
  return dynamicTemp.some(tempPath => tempPath && pathValue.startsWith(tempPath));
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
 * 发送消息（支持会话恢复）
 * @param {string} message - 要发送的消息
 * @param {string} resumeSessionId - 要恢复的会话ID
 * @param {string} cwd - 工作目录
 * @param {string} permissionMode - 权限模式（可选）
 */
async function sendMessage(message, resumeSessionId = null, cwd = null, permissionMode = null) {
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';
    console.log('[DEBUG] CLAUDE_CODE_ENTRYPOINT:', process.env.CLAUDE_CODE_ENTRYPOINT);

    // 设置 API Key 并获取配置信息
    const { apiKey, baseUrl, apiKeySource, baseUrlSource } = setupApiKey();

    console.log('[DEBUG] sendMessage called with params:', {
      resumeSessionId,
      cwd,
      permissionMode,
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

    // 准备选项
    const options = {
      cwd: workingDirectory,
      permissionMode: permissionMode || 'default', // 使用传入的权限模式，如果没有则默认
      model: 'sonnet',
      maxTurns: 100,
      additionalDirectories: Array.from(
        new Set(
          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
        )
      ),
      // 添加 canUseTool 回调来处理权限请求
      canUseTool: permissionMode === 'default' ? canUseTool : undefined
    };

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
        // send <message> [sessionId] [cwd] [permissionMode]
        await sendMessage(args[0], args[1], args[2], args[3]);
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
