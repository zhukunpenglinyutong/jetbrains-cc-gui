/**
 * Codex Message Service
 *
 * Handles message sending through Codex SDK (@openai/codex-sdk).
 * Provides unified interface that matches Claude's message service.
 *
 * Key Differences from Claude:
 * - Uses threadId instead of sessionId
 * - Permission model: skipGitRepoCheck + sandbox (not permissionMode string)
 * - Events: thread.*, turn.*, item.* (not system/assistant/user/result)
 * - Supports images via local_image type (requires file paths)
 *
 * @author Crafted with geek spirit
 */

// SDK 动态加载 - 不再静态导入，而是按需加载
import { loadCodexSdk, isCodexSdkAvailable } from '../../utils/sdk-loader.js';
import { CodexPermissionMapper } from '../../utils/permission-mapper.js';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { getRealHomeDir } from '../../utils/path-utils.js';

// SDK 缓存
let codexSdk = null;

// ========== Debug Logging Configuration ==========
// Log levels: 0 = off, 1 = errors only, 2 = warnings, 3 = info, 4 = debug, 5 = verbose
const DEBUG_LEVEL = process.env.CODEX_DEBUG_LEVEL ? parseInt(process.env.CODEX_DEBUG_LEVEL, 10) : 3;

/**
 * Conditional logging utility based on DEBUG_LEVEL
 * @param {number} level - Log level (1-5)
 * @param {string} tag - Log tag
 * @param  {...any} args - Log arguments
 */
function debugLog(level, tag, ...args) {
  if (DEBUG_LEVEL >= level) {
    console.log(`[${tag}]`, ...args);
  }
}

// Convenience functions for different log levels
const logError = (tag, ...args) => debugLog(1, tag, ...args);
const logWarn = (tag, ...args) => debugLog(2, tag, ...args);
const logInfo = (tag, ...args) => debugLog(3, tag, ...args);
const logDebug = (tag, ...args) => debugLog(4, tag, ...args);
const logVerbose = (tag, ...args) => debugLog(5, tag, ...args);

const isReconnectNotice = (message) =>
  typeof message === 'string' && /Reconnecting\.\.\./i.test(message);

const extractReconnectStatus = (message) => {
  if (typeof message !== 'string') return '';
  const match = message.match(/Reconnecting\.\.\.\s*\d+\/\d+/i);
  return match ? match[0] : message;
};

const emitStatusMessage = (emitMessage, message) => {
  const status = extractReconnectStatus(message);
  if (!status) return;
  emitMessage({ type: 'status', message: status });
};

/**
 * 确保 Codex SDK 已加载
 */
async function ensureCodexSdk() {
    if (!codexSdk) {
        if (!isCodexSdkAvailable()) {
            const error = new Error('Codex SDK not installed. Please install via Settings > Dependencies.');
            error.code = 'SDK_NOT_INSTALLED';
            error.provider = 'codex';
            throw error;
        }
        codexSdk = await loadCodexSdk();
    }
    return codexSdk;
}

const MAX_TOOL_RESULT_CHARS = 20000;

// AGENTS.md 最大读取字节数 (32KB，与 Codex CLI 一致)
const MAX_AGENTS_MD_BYTES = 32 * 1024;

// AGENTS.md 文件名搜索顺序
const AGENTS_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'];

/**
 * 查找 Git 仓库根目录
 * @param {string} startDir - 起始目录
 * @returns {string|null} Git 根目录或 null
 */
function findGitRoot(startDir) {
  let currentDir = startDir;
  const root = dirname(currentDir) === currentDir ? currentDir : null;

  while (currentDir) {
    const gitDir = join(currentDir, '.git');
    if (existsSync(gitDir)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // 已到达文件系统根目录
      break;
    }
    currentDir = parentDir;
  }
  return null;
}

/**
 * 在单个目录中搜索 AGENTS.md 文件
 * @param {string} dir - 要搜索的目录
 * @returns {string|null} 找到的文件路径或 null
 */
function findAgentsFileInDir(dir) {
  for (const fileName of AGENTS_FILE_NAMES) {
    const filePath = join(dir, fileName);
    try {
      if (existsSync(filePath)) {
        const stats = statSync(filePath);
        if (stats.isFile() && stats.size > 0) {
          return filePath;
        }
      }
    } catch (e) {
      // 忽略权限错误等
    }
  }
  return null;
}

/**
 * 读取 AGENTS.md 文件内容
 * @param {string} filePath - 文件路径
 * @returns {string} 文件内容（可能被截断）
 */
function readAgentsFile(filePath) {
  try {
    const stats = statSync(filePath);
    const content = readFileSync(filePath, 'utf8');
    if (content.length > MAX_AGENTS_MD_BYTES) {
      logInfo('AGENTS.md', `File truncated from ${content.length} to ${MAX_AGENTS_MD_BYTES} bytes: ${filePath}`);
      return content.slice(0, MAX_AGENTS_MD_BYTES);
    }
    return content;
  } catch (e) {
    logWarn('AGENTS.md', `Failed to read file: ${filePath}`, e.message);
    return '';
  }
}

/**
 * 收集所有 AGENTS.md 指令（从项目根目录到当前目录）
 *
 * 搜索规则（与 Codex CLI 一致）：
 * 1. 全局指令: ~/.codex/AGENTS.override.md 或 ~/.codex/AGENTS.md
 * 2. 项目指令: 从 git 根目录到 cwd 的每一层目录
 *
 * @param {string} cwd - 当前工作目录
 * @returns {string} 合并后的指令内容
 */
function collectAgentsInstructions(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    return '';
  }

  const instructions = [];
  let totalBytes = 0;

  // 1. 首先读取全局指令 (~/.codex/)
  const codexHome = (process.env.CODEX_HOME && process.env.CODEX_HOME.trim())
    ? process.env.CODEX_HOME.trim()
    : join(getRealHomeDir(), '.codex');
  const globalFile = findAgentsFileInDir(codexHome);
  if (globalFile) {
    const content = readAgentsFile(globalFile);
    if (content.trim()) {
      logInfo('AGENTS.md', `Loaded global instructions: ${globalFile}`);
      instructions.push(`# Global Instructions (${globalFile})\n\n${content}`);
      totalBytes += content.length;
    }
  }

  // 2. 然后读取项目指令（从 git 根目录到 cwd）
  const gitRoot = findGitRoot(cwd);
  const searchRoot = gitRoot || cwd;

  // 收集从 searchRoot 到 cwd 的所有目录
  const directories = [];
  let currentDir = cwd;
  while (currentDir) {
    directories.unshift(currentDir); // 添加到数组开头，保持根到叶的顺序
    if (currentDir === searchRoot) {
      break;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // 按顺序读取每个目录的 AGENTS.md
  for (const dir of directories) {
    if (totalBytes >= MAX_AGENTS_MD_BYTES) {
      logInfo('AGENTS.md', `Reached max bytes limit (${MAX_AGENTS_MD_BYTES}), stopping collection`);
      break;
    }

    const file = findAgentsFileInDir(dir);
    if (file) {
      const content = readAgentsFile(file);
      if (content.trim()) {
        const relativePath = dir === searchRoot ? '(root)' : dir.replace(searchRoot, '.');
        logInfo('AGENTS.md', `Loaded project instructions: ${file}`);
        instructions.push(`# Project Instructions ${relativePath}\n\n${content}`);
        totalBytes += content.length;
      }
    }
  }

  if (instructions.length === 0) {
    logDebug('AGENTS.md', 'No AGENTS.md files found');
    return '';
  }

  logInfo('AGENTS.md', `Collected ${instructions.length} instruction files, total ${totalBytes} bytes`);
  return instructions.join('\n\n---\n\n');
}

/**
 * Send message to Codex (with optional thread resumption)
 *
 * @param {string} message - User message to send
 * @param {string} threadId - Thread ID to resume (optional)
 * @param {string} cwd - Working directory (optional)
 * @param {string} permissionMode - Unified permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {string} baseUrl - API base URL (optional, for custom endpoints)
 * @param {string} apiKey - API key (optional, for custom auth)
 * @param {string} reasoningEffort - Reasoning effort level (optional)
 * @param {Array} attachments - Image attachments in local_image format (optional)
 */
export async function sendMessage(
  message,
  threadId = null,
  cwd = null,
  permissionMode = null,
  model = null,
  baseUrl = null,
  apiKey = null,
  reasoningEffort = 'medium',
  attachments = []
) {
  try {
    console.log('[DEBUG] Codex sendMessage called with params:', {
      threadId,
      cwd,
      permissionMode,
      model,
      reasoningEffort,
      hasBaseUrl: !!baseUrl,
      hasApiKey: !!apiKey,
      attachmentsCount: attachments?.length || 0
    });

    console.log('[MESSAGE_START]');

    // ============================================================
    // 1. Initialize Codex SDK (动态加载)
    // ============================================================

    // 动态加载 Codex SDK
    const sdk = await ensureCodexSdk();
    const Codex = sdk.Codex || sdk.default || sdk;

    const codexOptions = {};

    // Configure custom API endpoint
    if (baseUrl) {
      codexOptions.baseUrl = baseUrl;
    }

    // Configure custom API key
    if (apiKey) {
      codexOptions.apiKey = apiKey;
    }

    const codex = new Codex(codexOptions);

    // ============================================================
    // 2. Map Unified Permission Mode to Codex Format
    // ============================================================

    const permissionConfig = CodexPermissionMapper.toProvider(
      permissionMode || 'default'
    );

    console.log('[PERM_DEBUG] Codex permission config:', permissionConfig);

    // ============================================================
    // 3. Build Thread Options
    // ============================================================

    const threadOptions = {
      skipGitRepoCheck: permissionConfig.skipGitRepoCheck,
      maxTurns: 20  // Prevent infinite loops
    };

    // Set reasoning effort (thinking depth)
    if (reasoningEffort && reasoningEffort.trim() !== '') {
      threadOptions.modelReasoningEffort = reasoningEffort;
      console.log('[DEBUG] Reasoning effort:', reasoningEffort);
    }

    if (permissionConfig.approvalPolicy) {
      threadOptions.approvalPolicy = permissionConfig.approvalPolicy;
    }

    // CRITICAL: Only set working directory for NEW threads
    // When resuming an existing thread, Codex SDK needs to find the session file
    // in its default location (~/.codex/sessions/), so we must NOT override workingDirectory
    const isResumingThread = threadId && threadId.trim() !== '';

    if (!isResumingThread) {
      // New thread: set working directory if provided
      if (cwd && cwd.trim() !== '') {
        threadOptions.workingDirectory = cwd;
        console.log('[DEBUG] Working directory:', cwd);
      }
    } else {
      console.log('[DEBUG] Resuming thread - skipping workingDirectory to allow session lookup');
    }

    // Set model
    if (model && model.trim() !== '') {
      threadOptions.model = model;
      console.log('[DEBUG] Model:', model);
    }

    // Set sandbox mode (permission restriction)
    if (permissionConfig.sandbox) {
      threadOptions.sandboxMode = permissionConfig.sandbox;
      console.log('[DEBUG] Sandbox mode:', permissionConfig.sandbox);
    }

    // Final configuration log for debugging
    console.log('[PERM_DEBUG] Final Codex threadOptions:', {
      permissionMode: permissionMode,
      sandboxMode: threadOptions.sandboxMode,
      approvalPolicy: threadOptions.approvalPolicy,
      skipGitRepoCheck: threadOptions.skipGitRepoCheck
    });

    // ============================================================
    // 4. Create or Resume Thread
    // ============================================================

    let thread;
    if (isResumingThread) {
      console.log('[DEBUG] Resuming thread:', threadId);
      thread = codex.resumeThread(threadId, threadOptions);
    } else {
      console.log('[DEBUG] Starting new thread');
      thread = codex.startThread(threadOptions);
    }

    // ============================================================
    // 5. Collect AGENTS.md Instructions (only for new threads)
    // ============================================================

    let finalMessage = message;
    if (!isResumingThread && cwd) {
      const agentsInstructions = collectAgentsInstructions(cwd);
      if (agentsInstructions) {
        // 将 AGENTS.md 指令作为系统指令附加到消息前面
        finalMessage = `<agents-instructions>\n${agentsInstructions}\n</agents-instructions>\n\n${message}`;
        logDebug('AGENTS.md', `Prepended ${agentsInstructions.length} chars of instructions to message`);
      }
    }

    // ============================================================
    // 6. Execute Streaming Query
    // ============================================================

    // Build input for Codex SDK
    // If we have attachments, use array format: [{ type: "text", text: ... }, { type: "local_image", path: ... }]
    // Otherwise, use simple string format for backward compatibility
    let runInput;
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      // Build array format input with text and images
      runInput = [
        { type: 'text', text: finalMessage }
      ];

      // Add image attachments
      for (const attachment of attachments) {
        if (attachment && attachment.type === 'local_image' && attachment.path) {
          runInput.push({
            type: 'local_image',
            path: attachment.path
          });
          console.log('[DEBUG] Added local_image attachment:', attachment.path);
        }
      }

      console.log('[DEBUG] Using array input format with', runInput.length, 'entries');
    } else {
      // Use simple string format
      runInput = finalMessage;
      console.log('[DEBUG] Using string input format');
    }

    const { events } = await thread.runStreamed(runInput);

    let currentThreadId = threadId;
    let finalResponse = '';
    let assistantText = '';
    const pendingToolUseIdsByCommand = new Map();
    const emittedToolUseIds = new Set();
    const reasoningTextCache = new Map();
    let reasoningObserved = false;

    const emitMessage = (msg) => {
      console.log('[MESSAGE]', JSON.stringify(msg));
    };

    const truncateForDisplay = (text, maxChars) => {
      if (typeof text !== 'string') {
        return String(text ?? '');
      }
      if (maxChars <= 0 || text.length <= maxChars) {
        return text;
      }
      const head = Math.max(0, Math.floor(maxChars * 0.65));
      const tail = Math.max(0, maxChars - head);
      const prefix = text.slice(0, head);
      const suffix = tail > 0 ? text.slice(Math.max(0, text.length - tail)) : '';
      return `${prefix}\n...\n(truncated, original length: ${text.length} chars)\n...\n${suffix}`;
    };

    const getStableItemId = (item) => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item.id ?? item.item_id ?? item.uuid;
      return typeof candidate === 'string' && candidate.trim() ? candidate : null;
    };

    const extractCommand = (item) => {
      const cmd = item?.command;
      return typeof cmd === 'string' ? cmd : '';
    };

    const rememberPendingToolUseId = (command, toolUseId) => {
      if (!command) return;
      const list = pendingToolUseIdsByCommand.get(command) ?? [];
      list.push(toolUseId);
      pendingToolUseIdsByCommand.set(command, list);
    };

    const consumePendingToolUseId = (command) => {
      if (!command) return null;
      const list = pendingToolUseIdsByCommand.get(command);
      if (!Array.isArray(list) || list.length === 0) return null;
      const id = list.shift() ?? null;
      if (list.length === 0) {
        pendingToolUseIdsByCommand.delete(command);
      } else {
        pendingToolUseIdsByCommand.set(command, list);
      }
      return id;
    };

    const ensureToolUseId = (phase, item) => {
      const stableId = getStableItemId(item);
      if (stableId) return stableId;

      const command = extractCommand(item);
      if (phase === 'completed') {
        return consumePendingToolUseId(command) ?? randomUUID();
      }

      const id = randomUUID();
      rememberPendingToolUseId(command, id);
      return id;
    };

    /**
     * Extract actual command from shell wrapper
     * Handles formats like: /bin/zsh -lc 'cd dir && command'
     */
    const extractActualCommand = (command) => {
      if (!command || typeof command !== 'string') {
        return command;
      }

      let cmd = command.trim();

      // Extract from /bin/zsh -lc '...' or /bin/bash -c '...'
      const shellWrapperMatch = cmd.match(/^\/bin\/(zsh|bash)\s+(?:-lc|-c)\s+['"](.+)['"]$/);
      if (shellWrapperMatch) {
        cmd = shellWrapperMatch[2];
      }

      // Remove 'cd dir &&' prefix if present
      const cdPrefixMatch = cmd.match(/^cd\s+\S+\s+&&\s+(.+)$/);
      if (cdPrefixMatch) {
        cmd = cdPrefixMatch[1];
      }

      return cmd.trim();
    };

    /**
     * Smart tool name conversion - matches HistoryHandler.java logic
     * Converts shell commands to more specific tool types based on command pattern
     */
    const smartToolName = (command) => {
      if (!command || typeof command !== 'string') {
        return 'bash';
      }

      // Extract actual command from shell wrapper
      const actualCmd = extractActualCommand(command);

      // File viewing commands -> read
      if (/^(ls|pwd|find|cat|head|tail|file|stat|tree)\b/.test(actualCmd)) {
        return 'read';
      }

      // sed -n (read-only mode for viewing specific lines) -> read
      // Example: sed -n '700,780p' file.txt
      if (/^sed\s+-n\s+/.test(actualCmd)) {
        return 'read';
      }

      // Search commands -> glob (collapsible)
      if (/^(grep|rg|ack|ag)\b/.test(actualCmd)) {
        return 'glob';
      }

      // Other commands stay as bash
      return 'bash';
    };

    /**
     * Generate smart description based on command pattern
     * Provides more meaningful descriptions than generic "Codex command execution"
     */
    const smartDescription = (command) => {
      if (!command || typeof command !== 'string') {
        return 'Execute command';
      }

      // Extract actual command from shell wrapper
      const actualCmd = extractActualCommand(command);
      const firstWord = actualCmd.split(/\s+/)[0];

      // File viewing commands
      if (/^ls\b/.test(actualCmd)) return 'List directory contents';
      if (/^pwd\b/.test(actualCmd)) return 'Show current directory';
      if (/^cat\b/.test(actualCmd)) return 'Read file contents';
      if (/^head\b/.test(actualCmd)) return 'Read first lines';
      if (/^tail\b/.test(actualCmd)) return 'Read last lines';
      if (/^find\b/.test(actualCmd)) return 'Find files';
      if (/^tree\b/.test(actualCmd)) return 'Show directory tree';

      // sed -n for reading specific lines
      if (/^sed\s+-n\s+/.test(actualCmd)) return 'Read file lines';

      // Search commands
      if (/^(grep|rg|ack|ag)\b/.test(actualCmd)) return 'Search in files';

      // Git commands
      if (/^git\s+status\b/.test(actualCmd)) return 'Check git status';
      if (/^git\s+diff\b/.test(actualCmd)) return 'Show git diff';
      if (/^git\s+log\b/.test(actualCmd)) return 'Show git log';
      if (/^git\s+add\b/.test(actualCmd)) return 'Stage changes';
      if (/^git\s+commit\b/.test(actualCmd)) return 'Commit changes';
      if (/^git\s+push\b/.test(actualCmd)) return 'Push to remote';
      if (/^git\s+pull\b/.test(actualCmd)) return 'Pull from remote';
      if (/^git\s+/.test(actualCmd)) return `Run git ${actualCmd.substring(4).split(/\s+/)[0]}`;

      // Build/Package commands
      if (/^npm\s+install\b/.test(actualCmd)) return 'Install npm packages';
      if (/^npm\s+run\b/.test(actualCmd)) return 'Run npm script';
      if (/^npm\s+/.test(actualCmd)) return `Run npm ${actualCmd.substring(4).split(/\s+/)[0]}`;
      if (/^(yarn|pnpm)\s+/.test(actualCmd)) return `Run ${firstWord} command`;
      if (/^(gradle|mvn|make)\b/.test(actualCmd)) return `Run ${firstWord} build`;

      // Default: use command as-is for short commands, or first word for long ones
      return actualCmd.length <= 30 ? actualCmd : `Run ${firstWord}`;
    };

    const emitThinkingBlock = (text) => {
      console.log('[THINKING]', text);
      emitMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: text,
              text
            }
          ]
        }
      });
    };

    const maybeEmitReasoning = (item) => {
      if (!item || item.type !== 'reasoning') return;
      const raw = typeof item.text === 'string' ? item.text : '';
      const text = raw.trim();
      if (!text) return;
      const stableId = getStableItemId(item) ?? randomUUID();
      if (reasoningTextCache.get(stableId) === text) {
        return;
      }
      reasoningTextCache.set(stableId, text);
      reasoningObserved = true;
      emitThinkingBlock(text);
    };

    // ============================================================
    // 7. Process Events and Map to Claude-Compatible [MESSAGE] JSON
    // ============================================================

    for await (const event of events) {
      console.log('[DEBUG] Codex event:', event.type);

      switch (event.type) {
        case 'thread.started': {
          currentThreadId = event.thread_id;
          console.log('[THREAD_ID]', currentThreadId);
          break;
        }

        case 'turn.started': {
          console.log('[DEBUG] Turn started');
          break;
        }

        case 'item.started': {
          maybeEmitReasoning(event.item);
          if (event.item && event.item.type === 'command_execution') {
            const toolUseId = ensureToolUseId('started', event.item);
            const command = extractCommand(event.item);

            // Use smart tool name and description conversion
            const toolName = smartToolName(command);
            const description = smartDescription(command);

            emitMessage({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: toolUseId,
                    name: toolName,
                    input: {
                      command,
                      description
                    }
                  }
                ]
              }
            });
            emittedToolUseIds.add(toolUseId);
          }
          // Handle MCP tool call started
          else if (event.item && event.item.type === 'mcp_tool_call') {
            const toolUseId = event.item.id || randomUUID();
            // Build tool name: mcp__{server}__{tool}
            const toolName = `mcp__${event.item.server}__${event.item.tool}`;

            console.log('[DEBUG] MCP tool call started:', toolName, 'id:', toolUseId);

            emitMessage({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: toolUseId,
                    name: toolName,
                    input: event.item.arguments || {}
                  }
                ]
              }
            });
            emittedToolUseIds.add(toolUseId);
          }
          break;
        }

        case 'item.updated': {
          maybeEmitReasoning(event.item);
          break;
        }

        case 'item.completed': {
          if (!event.item) break;

          // 【DEBUG】详细记录 item 信息，帮助诊断
          console.log('[DEBUG] item.completed - type:', event.item.type);
          console.log('[DEBUG] item.completed - has text:', !!event.item.text);
          console.log('[DEBUG] item.completed - has agent_message:', !!event.item.agent_message);

          maybeEmitReasoning(event.item);

          if (event.item.type === 'agent_message') {
            const text = event.item.text || '';
            console.log('[DEBUG] agent_message text length:', text.length);
            console.log('[DEBUG] agent_message text (first 100 chars):', text.substring(0, 100));
            console.log('[DEBUG] agent_message text.trim() length:', text.trim().length);

            finalResponse = text;
            assistantText += text;
            if (text && text.trim()) {
              console.log('[DEBUG] About to emit agent message');
              emitMessage({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text }]
                }
              });
              console.log('[DEBUG] Agent message emitted');
            } else {
              console.log('[DEBUG] Skipping empty agent message');
            }
          } else if (event.item.type === 'command_execution') {
            const toolUseId = ensureToolUseId('completed', event.item);
            const command = extractCommand(event.item);
            const output =
              event.item.aggregated_output ??
              event.item.output ??
              event.item.stdout ??
              event.item.result ??
              '';
            const outputStrRaw = typeof output === 'string' ? output : JSON.stringify(output);
            const outputStr = truncateForDisplay(outputStrRaw, MAX_TOOL_RESULT_CHARS);
            const isError =
              (typeof event.item.exit_code === 'number' && event.item.exit_code !== 0) ||
              event.item.is_error === true;

            // Use smart tool name and description conversion
            const toolName = smartToolName(command);
            const description = smartDescription(command);

            if (!emittedToolUseIds.has(toolUseId)) {
              emitMessage({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool_use',
                      id: toolUseId,
                      name: toolName,
                      input: {
                        command,
                        description
                      }
                    }
                  ]
                }
              });
              emittedToolUseIds.add(toolUseId);
            }

            emitMessage({
              type: 'user',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    is_error: isError,
                    content: outputStr && outputStr.trim() ? outputStr : '(no output)'
                  }
                ]
              }
            });
          }
          // Handle MCP tool call completed
          else if (event.item.type === 'mcp_tool_call') {
            const toolUseId = event.item.id || randomUUID();
            const toolName = `mcp__${event.item.server}__${event.item.tool}`;
            const isError = event.item.status === 'failed' || !!event.item.error;

            console.log('[DEBUG] MCP tool call completed:', toolName, 'id:', toolUseId, 'error:', isError);

            // Emit tool_use if not already emitted
            if (!emittedToolUseIds.has(toolUseId)) {
              emitMessage({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool_use',
                      id: toolUseId,
                      name: toolName,
                      input: event.item.arguments || {}
                    }
                  ]
                }
              });
              emittedToolUseIds.add(toolUseId);
            }

            // Extract result content
            let resultContent = '(no output)';
            if (event.item.error) {
              resultContent = event.item.error.message || 'MCP tool call failed';
            } else if (event.item.result) {
              // result: { content: ContentBlock[], structured_content: unknown }
              if (event.item.result.content && Array.isArray(event.item.result.content)) {
                // Extract text from content blocks
                const textParts = event.item.result.content
                  .filter(block => block.type === 'text')
                  .map(block => block.text);
                resultContent = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(event.item.result);
              } else if (event.item.result.structured_content) {
                resultContent = JSON.stringify(event.item.result.structured_content);
              } else {
                resultContent = JSON.stringify(event.item.result);
              }
            }

            // Truncate if needed
            const truncatedResult = truncateForDisplay(resultContent, MAX_TOOL_RESULT_CHARS);

            // Emit tool_result
            emitMessage({
              type: 'user',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    is_error: isError,
                    content: truncatedResult && truncatedResult.trim() ? truncatedResult : '(no output)'
                  }
                ]
              }
            });
          } else {
            console.log('[DEBUG] Unhandled item.completed item type:', event.item.type);
          }
          break;
        }

        case 'turn.completed': {
          console.log('[DEBUG] Turn completed');
          if (event.usage) {
            console.log('[DEBUG] Token usage:', event.usage);

            // Convert Codex usage format to Claude-compatible format
            // Codex format: { input_tokens, cached_input_tokens, output_tokens }
            // Claude format: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
            const claudeUsage = {
              input_tokens: event.usage.input_tokens || 0,
              output_tokens: event.usage.output_tokens || 0,
              cache_creation_input_tokens: 0, // Codex doesn't provide this
              cache_read_input_tokens: event.usage.cached_input_tokens || 0
            };

            // Emit usage statistics as a result-like message for compatibility with Java layer
            // This allows the frontend to display usage statistics for Codex sessions
            const usageMessage = {
              type: 'result',
              subtype: 'usage',
              is_error: false,
              usage: claudeUsage,
              session_id: currentThreadId,
              uuid: randomUUID()
            };

            emitMessage(usageMessage);
            console.log('[DEBUG] Emitted usage statistics (Claude-compatible format):', claudeUsage);
          }
          break;
        }

        case 'turn.failed': {
          const errorMsg = event.error?.message || 'Turn failed';
          if (isReconnectNotice(errorMsg)) {
            console.warn('[DEBUG] Codex reconnect notice:', errorMsg);
            emitStatusMessage(emitMessage, errorMsg);
            break;
          }
          console.error('[DEBUG] Turn failed:', errorMsg);
          throw new Error(errorMsg);
        }

        case 'error': {
          const generalError = event.message || 'Unknown error';
          if (isReconnectNotice(generalError)) {
            console.warn('[DEBUG] Codex reconnect notice:', generalError);
            emitStatusMessage(emitMessage, generalError);
            break;
          }
          console.error('[DEBUG] Codex error:', generalError);
          throw new Error(generalError);
        }

        default: {
          // Log unknown events with more details to help diagnose MCP tool issues
          const payloadType = event.payload?.type;
          console.log('[DEBUG] Unknown event type:', event.type, 'payload.type:', payloadType);
          if (event.type === 'event_msg' || payloadType === 'function_call' || payloadType === 'function_call_output') {
            console.log('[DEBUG] Full event:', JSON.stringify(event).substring(0, 500));
          }
        }
      }
    }

    if (!reasoningObserved) {
      console.warn('[THINKING_HINT]', 'Codex did not return reasoning items. If you still cannot see the thinking process, please refer to docs/codex/docs/config.md for hide_agent_reasoning/show_raw_agent_reasoning settings, and ensure your OpenAI account has been verified.');
    }

    // ============================================================
    // 8. Send Completion Signal
    // ============================================================

    // If no agent message received, provide explanation
    if (assistantText.length === 0) {
      const noResponseMsg = [
        '\n⚠️ Codex completed tool executions but did not generate a text response.',
        'This may happen when:',
        '- The task was purely about gathering information',
        '- Codex reached maxTurns limit (20 turns)',
        '- The query required only command execution',
        '\nPlease try:',
        '- Asking a more specific question',
        '- Requesting explicit analysis or explanation',
        '- Checking the command outputs above for your answer'
      ].join('\n');

      emitMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: noResponseMsg }]
        }
      });
      finalResponse = noResponseMsg;
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      threadId: currentThreadId,
      result: finalResponse
    }));

  } catch (error) {
    console.error('[DEBUG] Error:', error.message);
    console.error('[DEBUG] Error stack:', error.stack);

    const errorPayload = buildErrorPayload(error);
    console.error('[SEND_ERROR]', JSON.stringify(errorPayload));
    console.log(JSON.stringify(errorPayload));
  }
}

/**
 * Build error response with helpful diagnostics
 *
 * @param {Error} error - The error object
 * @returns {object} Structured error payload
 */
function buildErrorPayload(error) {
  const rawError = error?.message || String(error);
  const errorName = error?.name || 'Error';

  // Detect common error types
  const isAuthError = rawError.includes('API key') ||
                      rawError.includes('authentication') ||
                      rawError.includes('unauthorized') ||
                      rawError.includes('401') ||
                      rawError.includes('Missing environment variable') ||
                      rawError.includes('CODEX_API_KEY');

  const isNetworkError = rawError.includes('ECONNREFUSED') ||
                         rawError.includes('ETIMEDOUT') ||
                         rawError.includes('network') ||
                         rawError.includes('fetch failed');

  let userMessage;

  if (isAuthError) {
    userMessage = [
      'Codex authentication error:',
      `- Error message: ${rawError}`,
      '',
      'Please check the following:',
      '1. Is the Codex API Key in plugin settings correct',
      '2. Does the API Key have sufficient permissions',
      '3. If using a custom Base URL, please confirm the address is correct',
      '',
      'Tip: Codex requires a valid OpenAI API Key'
    ].join('\n');
  } else if (isNetworkError) {
    userMessage = [
      'Codex network error:',
      `- Error message: ${rawError}`,
      '',
      'Please check:',
      '1. Is the network connection working',
      '2. If using a proxy, please confirm proxy configuration',
      '3. Is the firewall blocking the connection'
    ].join('\n');
  } else {
    userMessage = [
      'Codex error:',
      `- Error message: ${rawError}`,
      '',
      'Please check network connection and Codex configuration'
    ].join('\n');
  }

  return {
    success: false,
    error: userMessage,
    details: {
      rawError,
      errorName,
      isAuthError,
      isNetworkError
    }
  };
}
