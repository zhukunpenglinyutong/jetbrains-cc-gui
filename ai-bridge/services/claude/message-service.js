/**
 * 消息发送服务模块
 * 负责通过 Claude Agent SDK 发送消息
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

import { setupApiKey, isCustomBaseUrl, loadClaudeSettings } from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import { mapModelIdToSdkName } from '../../utils/model-utils.js';
import { AsyncStream } from '../../utils/async-stream.js';
import { canUseTool } from '../../permission-handler.js';
import { persistJsonlMessage, loadSessionHistory } from './session-service.js';
import { loadAttachments, buildContentBlocks } from './attachment-service.js';
import { buildIDEContextPrompt } from '../system-prompts.js';

/**
 * 发送消息（支持会话恢复）
 * @param {string} message - 要发送的消息
 * @param {string} resumeSessionId - 要恢复的会话ID
 * @param {string} cwd - 工作目录
 * @param {string} permissionMode - 权限模式（可选）
 * @param {string} model - 模型名称（可选）
 */
	function buildConfigErrorPayload(error) {
			  try {
			    const rawError = error?.message || String(error);
			    const errorName = error?.name || 'Error';
			    const errorStack = error?.stack || null;
	
			    // 之前这里对 AbortError / "Claude Code process aborted by user" 做了超时提示
			    // 现在统一走错误处理逻辑，但仍然在 details 中记录是否为超时/中断类错误，方便排查
			    const isAbortError =
			      errorName === 'AbortError' ||
			      rawError.includes('Claude Code process aborted by user') ||
			      rawError.includes('The operation was aborted');
	
		    const settings = loadClaudeSettings();
	    const env = settings?.env || {};

    const settingsApiKey =
      env.ANTHROPIC_AUTH_TOKEN !== undefined && env.ANTHROPIC_AUTH_TOKEN !== null
        ? env.ANTHROPIC_AUTH_TOKEN
        : env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== null
          ? env.ANTHROPIC_API_KEY
          : null;

    const settingsBaseUrl =
      env.ANTHROPIC_BASE_URL !== undefined && env.ANTHROPIC_BASE_URL !== null
        ? env.ANTHROPIC_BASE_URL
        : null;

    // 注意：配置只从 settings.json 读取，不再检查 shell 环境变量
    let keySource = '未配置';
    let rawKey = null;

    if (settingsApiKey !== null) {
      rawKey = String(settingsApiKey);
      if (env.ANTHROPIC_AUTH_TOKEN !== undefined && env.ANTHROPIC_AUTH_TOKEN !== null) {
        keySource = '~/.claude/settings.json: ANTHROPIC_AUTH_TOKEN';
      } else if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== null) {
        keySource = '~/.claude/settings.json: ANTHROPIC_API_KEY';
      } else {
        keySource = '~/.claude/settings.json';
      }
    }

    const keyPreview = rawKey && rawKey.length > 0
      ? `${rawKey.substring(0, 10)}...（长度 ${rawKey.length} 字符）`
      : '未配置（值为空或缺失）';

		    let baseUrl = settingsBaseUrl || 'https://api.anthropic.com';
		    let baseUrlSource;
		    if (settingsBaseUrl) {
		      baseUrlSource = '~/.claude/settings.json: ANTHROPIC_BASE_URL';
		    } else {
		      baseUrlSource = '默认值（https://api.anthropic.com）';
		    }
		
		    const heading = isAbortError
		      ? 'Claude Code 运行被中断（可能是响应超时或用户取消）：'
		      : 'Claude Code 出现错误：';
		
		    const userMessage = [
	      heading,
	      `- 错误信息: ${rawError}`,
	      `- 当前 API Key 来源: ${keySource}`,
	      `- 当前 API Key 预览: ${keyPreview}`,
	      `- 当前 Base URL: ${baseUrl}（来源: ${baseUrlSource}）`,
	      `- tip：cli可以读取 环境变量 或者 setting.json 两种方式；本插件为了避免产生问题，只支持读取setting.json 内容，您可以在 本插件右上角设置 - 供应商管理配置下即可使用`,
	      ''
	    ].join('\n');

	    return {
	      success: false,
	      error: userMessage,
	      details: {
	        rawError,
	        errorName,
	        errorStack,
	        isAbortError,
	        keySource,
	        keyPreview,
	        baseUrl,
	        baseUrlSource
	      }
	    };
  } catch (innerError) {
    const rawError = error?.message || String(error);
    return {
      success: false,
      error: rawError,
      details: {
        rawError,
        buildErrorFailed: String(innerError)
      }
    };
  }
}

export async function sendMessage(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, openedFiles = null) {
	  let timeoutId;
	  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';
    console.log('[DEBUG] CLAUDE_CODE_ENTRYPOINT:', process.env.CLAUDE_CODE_ENTRYPOINT);

    // 设置 API Key 并获取配置信息（包含认证类型）
    const { baseUrl, authType, apiKeySource, baseUrlSource } = setupApiKey();

    // 检测是否使用自定义 Base URL
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

    // 将模型 ID 映射为 SDK 期望的名称
    const sdkModelName = mapModelIdToSdkName(model);
    console.log('[DEBUG] Model mapping:', model, '->', sdkModelName);

	    // Build systemPrompt.append content (for adding opened files context)
	    // 使用统一的提示词管理模块构建 IDE 上下文提示词
	    const systemPromptAppend = buildIDEContextPrompt(openedFiles);

	    // 准备选项
	    // 注意：不再传递 pathToClaudeCodeExecutable，让 SDK 自动使用内置 cli.js
	    // 这样可以避免 Windows 下系统 CLI 路径问题（ENOENT 错误）
	    const effectivePermissionMode = permissionMode || 'default';
	    const shouldUseCanUseTool = effectivePermissionMode === 'default';
	    console.log('[PERM_DEBUG] permissionMode:', permissionMode);
	    console.log('[PERM_DEBUG] effectivePermissionMode:', effectivePermissionMode);
	    console.log('[PERM_DEBUG] shouldUseCanUseTool:', shouldUseCanUseTool);
	    console.log('[PERM_DEBUG] canUseTool function defined:', typeof canUseTool);

    // 🔧 从 settings.json 读取 Extended Thinking 配置
    const settings = loadClaudeSettings();
    const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
    const configuredMaxThinkingTokens = settings?.maxThinkingTokens
      || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
      || 10000;

	    // 根据配置决定是否启用 Extended Thinking
	    // - 如果 alwaysThinkingEnabled 为 true，使用配置的 maxThinkingTokens 值
	    // - 如果 alwaysThinkingEnabled 为 false，不设置 maxThinkingTokens（让 SDK 使用默认行为）
	    const maxThinkingTokens = alwaysThinkingEnabled ? configuredMaxThinkingTokens : undefined;

	    console.log('[THINKING_DEBUG] alwaysThinkingEnabled:', alwaysThinkingEnabled);
	    console.log('[THINKING_DEBUG] maxThinkingTokens:', maxThinkingTokens);

	    const options = {
	      cwd: workingDirectory,
	      permissionMode: effectivePermissionMode,
	      model: sdkModelName,
	      maxTurns: 100,
	      // Extended Thinking 配置（根据 settings.json 的 alwaysThinkingEnabled 决定）
	      // 思考内容会通过 [THINKING] 标签输出给前端展示
	      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
	      additionalDirectories: Array.from(
	        new Set(
	          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
	        )
	      ),
	      canUseTool: shouldUseCanUseTool ? canUseTool : undefined,
	      // 不传递 pathToClaudeCodeExecutable，SDK 将自动使用内置 cli.js
	      settingSources: ['user', 'project', 'local'],
	      // 使用 Claude Code 预设系统提示，让 Claude 知道当前工作目录
	      // 这是修复路径问题的关键：没有 systemPrompt 时 Claude 不知道 cwd
	      // 如果有 openedFiles，通过 append 字段添加打开文件的上下文
	      systemPrompt: {
	        type: 'preset',
	        preset: 'claude_code',
	        ...(systemPromptAppend && { append: systemPromptAppend })
	      }
	    };
	    console.log('[PERM_DEBUG] options.canUseTool:', options.canUseTool ? 'SET' : 'NOT SET');

		// 使用 AbortController 实现 60 秒超时控制（已发现严重问题，暂时禁用自动超时，仅保留正常查询逻辑）
		// const abortController = new AbortController();
		// options.abortController = abortController;

    console.log('[DEBUG] Using SDK built-in Claude CLI (cli.js)');

    console.log('[DEBUG] Options:', JSON.stringify(options, null, 2));

    // 如果有 sessionId 且不为空字符串，使用 resume 恢复会话
    if (resumeSessionId && resumeSessionId !== '') {
      options.resume = resumeSessionId;
      console.log('[RESUMING]', resumeSessionId);
    }

	    console.log('[DEBUG] Query started, waiting for messages...');
	
	    // 调用 query 函数
	    const result = query({
	      prompt: message,
	      options
	    });
	
		// 设置 60 秒超时，超时后通过 AbortController 取消查询（已发现严重问题，暂时注释掉自动超时逻辑）
		// timeoutId = setTimeout(() => {
		//   console.log('[DEBUG] Query timeout after 60 seconds, aborting...');
		//   abortController.abort();
		// }, 60000);
	
	    console.log('[DEBUG] Starting message loop...');

    let currentSessionId = resumeSessionId;

    // 流式输出
    let messageCount = 0;
    try {
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
            } else if (block.type === 'thinking') {
              // 输出思考过程（用于实时显示）
              const thinkingText = block.thinking || block.text || '';
              console.log('[THINKING]', thinkingText);
            } else if (block.type === 'tool_use') {
              console.log('[DEBUG] Tool use payload:', JSON.stringify(block));
            }
          }
        } else if (typeof content === 'string') {
          console.log('[CONTENT]', content);
        }
      }

      // 实时输出工具调用结果（user 消息中的 tool_result）
      if (msg.type === 'user') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              // 输出工具调用结果，前端可以实时更新工具状态
              console.log('[TOOL_RESULT]', JSON.stringify(block));
            }
          }
        }
      }

      // 捕获并保存 session_id
      if (msg.type === 'system' && msg.session_id) {
        currentSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);

        // 输出 slash_commands（如果存在）
        if (msg.subtype === 'init' && Array.isArray(msg.slash_commands)) {
          // console.log('[SLASH_COMMANDS]', JSON.stringify(msg.slash_commands));
        }
      }

      // 检查是否收到错误结果消息（快速检测 API Key 错误）
      if (msg.type === 'result' && msg.is_error) {
        console.error('[DEBUG] Received error result message:', JSON.stringify(msg));
        const errorText = msg.result || msg.message || 'API request failed';
        throw new Error(errorText);
      }
    }
    } catch (loopError) {
      // 捕获 for await 循环中的错误（包括 SDK 内部 spawn 子进程失败等）
      console.error('[DEBUG] Error in message loop:', loopError.message);
      console.error('[DEBUG] Error name:', loopError.name);
      console.error('[DEBUG] Error stack:', loopError.stack);
      // 检查是否是子进程相关错误
      if (loopError.code) {
        console.error('[DEBUG] Error code:', loopError.code);
      }
      if (loopError.errno) {
        console.error('[DEBUG] Error errno:', loopError.errno);
      }
      if (loopError.syscall) {
        console.error('[DEBUG] Error syscall:', loopError.syscall);
      }
      if (loopError.path) {
        console.error('[DEBUG] Error path:', loopError.path);
      }
      if (loopError.spawnargs) {
        console.error('[DEBUG] Error spawnargs:', JSON.stringify(loopError.spawnargs));
      }
      throw loopError; // 重新抛出让外层 catch 处理
    }

    console.log(`[DEBUG] Message loop completed. Total messages: ${messageCount}`);

	    console.log('[MESSAGE_END]');
	    console.log(JSON.stringify({
	      success: true,
	      sessionId: currentSessionId
	    }));
	
	  } catch (error) {
	    const payload = buildConfigErrorPayload(error);
	    console.error('[SEND_ERROR]', JSON.stringify(payload));
	    console.log(JSON.stringify(payload));
	  } finally {
	    if (timeoutId) clearTimeout(timeoutId);
	  }
	}

/**
 * 使用 Anthropic SDK 发送消息（用于第三方 API 代理的回退方案）
 */
export async function sendMessageWithAnthropicSDK(message, resumeSessionId, cwd, permissionMode, model, apiKey, baseUrl, authType) {
  try {
    const workingDirectory = selectWorkingDirectory(cwd);
    try { process.chdir(workingDirectory); } catch {}

    const sessionId = (resumeSessionId && resumeSessionId !== '') ? resumeSessionId : randomUUID();
    const modelId = model || 'claude-sonnet-4-5';

    // 根据认证类型使用正确的 SDK 参数
    // authType = 'auth_token': 使用 authToken 参数（Bearer 认证）
    // authType = 'api_key': 使用 apiKey 参数（x-api-key 认证）
    let client;
    if (authType === 'auth_token') {
      console.log('[DEBUG] Using Bearer authentication (ANTHROPIC_AUTH_TOKEN)');
      // 使用 authToken 参数（Bearer 认证）并清除 apiKey
      client = new Anthropic({
        authToken: apiKey,
        apiKey: null,  // 明确设置为 null 避免使用 x-api-key header
        baseURL: baseUrl || undefined
      });
      // 优先使用 Bearer（ANTHROPIC_AUTH_TOKEN），避免继续发送 x-api-key
      delete process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else {
      console.log('[DEBUG] Using API Key authentication (ANTHROPIC_API_KEY)');
      // 使用 apiKey 参数（x-api-key 认证）
      client = new Anthropic({
        apiKey,
        baseURL: baseUrl || undefined
      });
    }

    console.log('[MESSAGE_START]');
    console.log('[SESSION_ID]', sessionId);
    console.log('[DEBUG] Using Anthropic SDK fallback for custom Base URL (non-streaming)');
    console.log('[DEBUG] Model:', modelId);
    console.log('[DEBUG] Base URL:', baseUrl);
    console.log('[DEBUG] Auth type:', authType || 'api_key (default)');

    const userContent = [{ type: 'text', text: message }];

    persistJsonlMessage(sessionId, cwd, {
      type: 'user',
      message: { content: userContent }
    });

    let messagesForApi = [{ role: 'user', content: userContent }];
    if (resumeSessionId && resumeSessionId !== '') {
      const historyMessages = loadSessionHistory(sessionId, cwd);
      if (historyMessages.length > 0) {
        messagesForApi = [...historyMessages, { role: 'user', content: userContent }];
        console.log('[DEBUG] Loaded', historyMessages.length, 'history messages for session continuity');
      }
    }

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

    console.log('[DEBUG] Calling messages.create() with non-streaming API...');

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 8192,
      messages: messagesForApi
    });

    console.log('[DEBUG] API response received');

    if (response.error || response.type === 'error') {
      const errorMsg = response.error?.message || response.message || 'Unknown API error';
      console.error('[API_ERROR]', errorMsg);

      const errorContent = [{
        type: 'text',
        text: `API 错误: ${errorMsg}\n\n可能的原因:\n1. API Key 配置不正确\n2. 第三方代理服务配置问题\n3. 请检查 ~/.claude/settings.json 中的配置`
      }];

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

    persistJsonlMessage(sessionId, cwd, {
      type: 'assistant',
      message: { content: respContent }
    });

    for (const block of respContent) {
      if (block.type === 'text') {
        console.log('[CONTENT]', block.text);
      }
    }

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
    if (error.response) {
      console.error('[ERROR_DETAILS] Status:', error.response.status);
      console.error('[ERROR_DETAILS] Data:', JSON.stringify(error.response.data));
    }
    console.log(JSON.stringify({ success: false, error: error.message }));
  }
}

/**
 * 使用 Claude Agent SDK 发送带附件的消息（多模态）
 */
	export async function sendMessageWithAttachments(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, stdinData = null) {
	  let timeoutId;
	  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key 并获取配置信息（包含认证类型）
    const { baseUrl, authType } = setupApiKey();

    console.log('[MESSAGE_START]');

    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // 加载附件
    const attachments = await loadAttachments(stdinData);

    // 提取打开的文件列表（从 stdinData）
    const openedFiles = stdinData?.openedFiles || null;

    // Build systemPrompt.append content (for adding opened files context)
    // 使用统一的提示词管理模块构建 IDE 上下文提示词
    const systemPromptAppend = buildIDEContextPrompt(openedFiles);

    // 构建用户消息内容块
    const contentBlocks = buildContentBlocks(attachments, message);

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

    const sdkModelName = mapModelIdToSdkName(model);
    // 不再查找系统 CLI，使用 SDK 内置 cli.js
    console.log('[DEBUG] (withAttachments) Using SDK built-in Claude CLI (cli.js)');

    // 创建输入流并放入用户消息
    const inputStream = new AsyncStream();
    inputStream.enqueue(userMessage);
    inputStream.done();

    // 规范化 permissionMode：空字符串或 null 都视为 'default'
    // 参见 docs/multimodal-permission-bug.md
    const normalizedPermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
    console.log('[PERM_DEBUG] (withAttachments) permissionMode:', permissionMode);
    console.log('[PERM_DEBUG] (withAttachments) normalizedPermissionMode:', normalizedPermissionMode);

    // PreToolUse hook 用于权限控制（替代 canUseTool，因为在 AsyncIterable 模式下 canUseTool 不被调用）
    // 参见 docs/multimodal-permission-bug.md
    const preToolUseHook = async (input) => {
      console.log('[PERM_DEBUG] (withAttachments) PreToolUse hook called:', input.tool_name);

      // 非 default 模式下自动允许所有工具
      if (normalizedPermissionMode !== 'default') {
        console.log('[PERM_DEBUG] (withAttachments) Auto-approve (non-default mode)');
        return { decision: 'approve' };
      }

      // 调用 canUseTool 进行权限检查
      console.log('[PERM_DEBUG] (withAttachments) Calling canUseTool...');
      try {
        const result = await canUseTool(input.tool_name, input.tool_input);
        console.log('[PERM_DEBUG] (withAttachments) canUseTool returned:', result.behavior);

        if (result.behavior === 'allow') {
          return { decision: 'approve' };
        } else if (result.behavior === 'deny') {
          return {
            decision: 'block',
            reason: result.message || 'Permission denied'
          };
        }
        return {};
      } catch (error) {
        console.error('[PERM_DEBUG] (withAttachments) canUseTool error:', error.message);
        return {
          decision: 'block',
          reason: 'Permission check failed: ' + error.message
        };
      }
    };

    // 注意：根据 SDK 文档，如果不指定 matcher，则该 Hook 会匹配所有工具
    // 这里统一使用一个全局 PreToolUse Hook，由 Hook 内部决定哪些工具自动放行

    // 🔧 从 settings.json 读取 Extended Thinking 配置
    const settings = loadClaudeSettings();
    const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
    const configuredMaxThinkingTokens = settings?.maxThinkingTokens
      || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
      || 10000;

    // 根据配置决定是否启用 Extended Thinking
    // - 如果 alwaysThinkingEnabled 为 true，使用配置的 maxThinkingTokens 值
    // - 如果 alwaysThinkingEnabled 为 false，不设置 maxThinkingTokens（让 SDK 使用默认行为）
    const maxThinkingTokens = alwaysThinkingEnabled ? configuredMaxThinkingTokens : undefined;

    console.log('[THINKING_DEBUG] (withAttachments) alwaysThinkingEnabled:', alwaysThinkingEnabled);
    console.log('[THINKING_DEBUG] (withAttachments) maxThinkingTokens:', maxThinkingTokens);

    const options = {
      cwd: workingDirectory,
      permissionMode: normalizedPermissionMode,
      model: sdkModelName,
      maxTurns: 100,
      // Extended Thinking 配置（根据 settings.json 的 alwaysThinkingEnabled 决定）
      // 思考内容会通过 [THINKING] 标签输出给前端展示
      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
      additionalDirectories: Array.from(
        new Set(
          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
        )
      ),
      // 同时设置 canUseTool 和 hooks，确保至少一个生效
      // 在 AsyncIterable 模式下 canUseTool 可能不被调用，所以必须配置 PreToolUse hook
      canUseTool: normalizedPermissionMode === 'default' ? canUseTool : undefined,
      hooks: normalizedPermissionMode === 'default' ? {
        PreToolUse: [{
          hooks: [preToolUseHook]
        }]
      } : undefined,
      // 不传递 pathToClaudeCodeExecutable，SDK 将自动使用内置 cli.js
      settingSources: ['user', 'project', 'local'],
      // 使用 Claude Code 预设系统提示，让 Claude 知道当前工作目录
      // 这是修复路径问题的关键：没有 systemPrompt 时 Claude 不知道 cwd
      // 如果有 openedFiles，通过 append 字段添加打开文件的上下文
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(systemPromptAppend && { append: systemPromptAppend })
      }
    };
    console.log('[PERM_DEBUG] (withAttachments) options.canUseTool:', options.canUseTool ? 'SET' : 'NOT SET');
    console.log('[PERM_DEBUG] (withAttachments) options.hooks:', options.hooks ? 'SET (PreToolUse)' : 'NOT SET');
    console.log('[PERM_DEBUG] (withAttachments) options.permissionMode:', options.permissionMode);

	    // 之前这里通过 AbortController + 30 秒自动超时来中断带附件的请求
	    // 这会导致在配置正确的情况下仍然出现 "Claude Code process aborted by user" 的误导性错误
	    // 为保持与纯文本 sendMessage 一致，这里暂时禁用自动超时逻辑，改由 IDE 侧中断控制
	    // const abortController = new AbortController();
	    // options.abortController = abortController;

	    if (resumeSessionId && resumeSessionId !== '') {
	      options.resume = resumeSessionId;
	      console.log('[RESUMING]', resumeSessionId);
	    }
	
		    const result = query({
		      prompt: inputStream,
		      options
		    });

	    // 如需再次启用自动超时，可在此处通过 AbortController 实现，并确保给出清晰的“响应超时”提示
	    // timeoutId = setTimeout(() => {
	    //   console.log('[DEBUG] Query with attachments timeout after 30 seconds, aborting...');
	    //   abortController.abort();
	    // }, 30000);
	
		    let currentSessionId = resumeSessionId;

		    try {
		    for await (const msg of result) {
	    	      console.log('[MESSAGE]', JSON.stringify(msg));

	    	      if (msg.type === 'assistant') {
	    	        const content = msg.message?.content;
	    	        if (Array.isArray(content)) {
	    	          for (const block of content) {
	    	            if (block.type === 'text') {
	    	              console.log('[CONTENT]', block.text);
	    	            } else if (block.type === 'tool_use') {
	    	              console.log('[DEBUG] Tool use payload (withAttachments):', JSON.stringify(block));
	    	            } else if (block.type === 'tool_result') {
	    	              console.log('[DEBUG] Tool result payload (withAttachments):', JSON.stringify(block));
	    	            }
	    	          }
	    	        } else if (typeof content === 'string') {
	    	          console.log('[CONTENT]', content);
	    	        }
	    	      }

	    	      // 实时输出工具调用结果（user 消息中的 tool_result）
	    	      if (msg.type === 'user') {
	    	        const content = msg.message?.content;
	    	        if (Array.isArray(content)) {
	    	          for (const block of content) {
	    	            if (block.type === 'tool_result') {
	    	              // 输出工具调用结果，前端可以实时更新工具状态
	    	              console.log('[TOOL_RESULT]', JSON.stringify(block));
	    	            }
	    	          }
	    	        }
	    	      }

	    	      if (msg.type === 'system' && msg.session_id) {
	    	        currentSessionId = msg.session_id;
	    	        console.log('[SESSION_ID]', msg.session_id);
	    	      }

	    	      // 检查是否收到错误结果消息（快速检测 API Key 错误）
	    	      if (msg.type === 'result' && msg.is_error) {
	    	        console.error('[DEBUG] (withAttachments) Received error result message:', JSON.stringify(msg));
	    	        const errorText = msg.result || msg.message || 'API request failed';
	    	        throw new Error(errorText);
	    	      }
	    	    }
	    	    } catch (loopError) {
	    	      // 捕获 for await 循环中的错误
	    	      console.error('[DEBUG] Error in message loop (withAttachments):', loopError.message);
	    	      console.error('[DEBUG] Error name:', loopError.name);
	    	      console.error('[DEBUG] Error stack:', loopError.stack);
	    	      if (loopError.code) console.error('[DEBUG] Error code:', loopError.code);
	    	      if (loopError.errno) console.error('[DEBUG] Error errno:', loopError.errno);
	    	      if (loopError.syscall) console.error('[DEBUG] Error syscall:', loopError.syscall);
	    	      if (loopError.path) console.error('[DEBUG] Error path:', loopError.path);
	    	      if (loopError.spawnargs) console.error('[DEBUG] Error spawnargs:', JSON.stringify(loopError.spawnargs));
	    	      throw loopError;
	    	    }

	    console.log('[MESSAGE_END]');
	    console.log(JSON.stringify({
	      success: true,
	      sessionId: currentSessionId
	    }));

	  } catch (error) {
	    const payload = buildConfigErrorPayload(error);
	    console.error('[SEND_ERROR]', JSON.stringify(payload));
	    console.log(JSON.stringify(payload));
	  } finally {
	    if (timeoutId) clearTimeout(timeoutId);
	  }
	}

/**
 * 获取斜杠命令列表
 * 通过 SDK 的 supportedCommands() 方法获取完整的命令列表
 * 这个方法不需要发送消息，可以在插件启动时调用
 */
export async function getSlashCommands(cwd = null) {
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key
    setupApiKey();

    // 确保 HOME 环境变量设置正确
    if (!process.env.HOME) {
      const os = await import('os');
      process.env.HOME = os.homedir();
    }

    // 智能确定工作目录
    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // 创建一个空的输入流
    const inputStream = new AsyncStream();

    // 调用 query 函数，使用空输入流
    // 这样不会发送任何消息，只是初始化 SDK 以获取配置
    const result = query({
      prompt: inputStream,
      options: {
        cwd: workingDirectory,
        permissionMode: 'default',
        maxTurns: 0,  // 不需要进行任何轮次
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'Config loading only'
        }),
        // 明确启用默认工具集
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        // 捕获 SDK stderr 调试日志，帮助定位 CLI 初始化问题
        stderr: (data) => {
          if (data && data.trim()) {
            console.log(`[SDK-STDERR] ${data.trim()}`);
          }
        }
      }
    });

    // 立即关闭输入流，告诉 SDK 我们没有消息要发送
    inputStream.done();

    // 获取支持的命令列表
    // SDK 返回的格式是 SlashCommand[]，包含 name 和 description
    const slashCommands = await result.supportedCommands?.() || [];

    // 清理资源
    await result.return?.();

    // 输出命令列表（包含 name 和 description）
    console.log('[SLASH_COMMANDS]', JSON.stringify(slashCommands));

    console.log(JSON.stringify({
      success: true,
      commands: slashCommands
    }));

  } catch (error) {
    console.error('[GET_SLASH_COMMANDS_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      commands: []
    }));
  }
}

/**
 * 获取 MCP 服务器连接状态
 * 通过 SDK 的 mcpServerStatus() 方法获取所有配置的 MCP 服务器的连接状态
 * @param {string} cwd - 工作目录（可选）
 */
export async function getMcpServerStatus(cwd = null) {
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key
    setupApiKey();

    // 确保 HOME 环境变量设置正确
    if (!process.env.HOME) {
      const os = await import('os');
      process.env.HOME = os.homedir();
    }

    // 智能确定工作目录
    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // 创建一个空的输入流
    const inputStream = new AsyncStream();

    // 调用 query 函数，使用空输入流
    const result = query({
      prompt: inputStream,
      options: {
        cwd: workingDirectory,
        permissionMode: 'default',
        maxTurns: 0,
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'Config loading only'
        }),
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        stderr: (data) => {
          if (data && data.trim()) {
            console.log(`[SDK-STDERR] ${data.trim()}`);
          }
        }
      }
    });

    // 立即关闭输入流
    inputStream.done();

    // 获取 MCP 服务器状态
    // SDK 返回的格式是 McpServerStatus[]，包含 name, status, serverInfo
    const mcpStatus = await result.mcpServerStatus?.() || [];

    // 清理资源
    await result.return?.();

    // 输出 MCP 服务器状态
    console.log('[MCP_SERVER_STATUS]', JSON.stringify(mcpStatus));

    console.log(JSON.stringify({
      success: true,
      servers: mcpStatus
    }));

  } catch (error) {
    console.error('[GET_MCP_SERVER_STATUS_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      servers: []
    }));
  }
}
