/**
 * Codex 消息发送服务模块
 * 使用 @openai/codex-sdk TypeScript SDK
 */

import { Codex } from '@openai/codex-sdk';

/**
 * 发送消息（支持会话恢复）
 * @param {string} message - 要发送的消息
 * @param {string} threadId - 要恢复的会话ID（可选）
 * @param {string} cwd - 工作目录（可选）
 * @param {string} model - 模型名称（可选）
 * @param {string} baseUrl - API 基础 URL（可选）
 * @param {string} apiKey - API 密钥（可选）
 */
export async function sendMessage(message, threadId = null, cwd = null, model = null, baseUrl = null, apiKey = null) {
  try {
    console.log('[DEBUG] sendMessage called with params:', {
      threadId,
      cwd,
      model,
      baseUrl: baseUrl ? '***' : null,
      apiKey: apiKey ? '***' : null
    });

    console.log('[MESSAGE_START]');

    // Codex 实例选项
    const codexOptions = {};

    // 设置 API 基础 URL
    if (baseUrl) {
      codexOptions.baseUrl = baseUrl;
    }

    // 设置 API 密钥
    if (apiKey) {
      codexOptions.apiKey = apiKey;
    }

    // 创建 Codex 实例
    const codex = new Codex(codexOptions);

    // 线程选项
    const threadOptions = {
      skipGitRepoCheck: true
    };

    // 设置工作目录
    if (cwd) {
      threadOptions.workingDirectory = cwd;
    }

    // 设置模型
    if (model) {
      threadOptions.model = model;
    }

    // 创建或恢复线程
    let thread;
    if (threadId && threadId !== '') {
      console.log('[DEBUG] Resuming thread:', threadId);
      thread = codex.resumeThread(threadId, threadOptions);
    } else {
      console.log('[DEBUG] Starting new thread');
      thread = codex.startThread(threadOptions);
    }

    // 使用流式响应
    const { events } = await thread.runStreamed(message);

    let currentThreadId = threadId;
    let finalResponse = '';

    for await (const event of events) {
      console.log('[DEBUG] Event:', event.type);

      // 处理不同类型的事件
      if (event.type === 'thread.started') {
        currentThreadId = event.thread_id;
        console.log('[THREAD_ID]', currentThreadId);
      } else if (event.type === 'item.completed') {
        if (event.item && event.item.type === 'agent_message') {
          finalResponse = event.item.text;
          console.log('[CONTENT]', finalResponse);
          console.log('[CONTENT_DELTA]', finalResponse);
        }
      } else if (event.type === 'turn.completed') {
        // 回合完成
        console.log('[DEBUG] Turn completed, usage:', event.usage);
      } else if (event.type === 'turn.failed') {
        throw new Error(event.error?.message || 'Turn failed');
      } else if (event.type === 'error') {
        throw new Error(event.message || 'Unknown error');
      }
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
 * 构建错误响应
 */
function buildErrorPayload(error) {
  const rawError = error?.message || String(error);
  const errorName = error?.name || 'Error';

  // 检查是否是 API Key 相关错误
  const isAuthError = rawError.includes('API key') ||
                      rawError.includes('authentication') ||
                      rawError.includes('unauthorized') ||
                      rawError.includes('401') ||
                      rawError.includes('Missing environment variable');

  let userMessage;
  if (isAuthError) {
    userMessage = [
      'Codex 认证错误：',
      `- 错误信息: ${rawError}`,
      '',
      '请检查 ~/.codex/config.toml 中的认证配置。',
      '注意：使用 api_key 而不是 env_key 来设置 API 密钥。'
    ].join('\n');
  } else {
    userMessage = [
      'Codex 出现错误：',
      `- 错误信息: ${rawError}`,
      '',
      '请检查网络连接和 Codex 配置。'
    ].join('\n');
  }

  return {
    success: false,
    error: userMessage,
    details: {
      rawError,
      errorName,
      isAuthError
    }
  };
}
