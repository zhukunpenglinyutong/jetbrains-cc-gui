#!/usr/bin/env node

/**
 * AI Bridge Channel Manager
 * 统一的 Claude 和 Codex SDK 桥接入口
 *
 * 命令格式:
 *   node channel-manager.js <provider> <command> [args...]
 *
 * Provider:
 *   claude - Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 *   codex  - Codex SDK (@openai/codex-sdk)
 *
 * Commands:
 *   send                - 发送消息（参数通过 stdin JSON 传递）
 *   sendWithAttachments - 发送带附件的消息（仅 claude）
 *   getSession          - 获取会话历史消息（仅 claude）
 *
 * 设计说明：
 * - 统一入口，根据 provider 参数分发到不同的服务
 * - sessionId/threadId 由调用方（Java）维护
 * - 消息和其他参数通过 stdin 以 JSON 格式传递
 */

// 共用工具
import { readStdinData } from './utils/stdin-utils.js';

// Claude 服务
import {
  sendMessage as claudeSendMessage,
  sendMessageWithAttachments as claudeSendMessageWithAttachments
} from './services/claude/message-service.js';
import { getSessionMessages as claudeGetSessionMessages } from './services/claude/session-service.js';

// Codex 服务 (暂时禁用 - SDK 已卸载)
// import { sendMessage as codexSendMessage } from './services/codex/message-service.js';

// 命令行参数解析
const provider = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

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

/**
 * Claude 命令处理
 */
async function handleClaudeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const { message, sessionId, cwd, permissionMode, model, openedFiles } = stdinData;
        await claudeSendMessage(message, sessionId || '', cwd || '', permissionMode || '', model || '', openedFiles || null);
      } else {
        await claudeSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'sendWithAttachments': {
      if (stdinData && stdinData.message !== undefined) {
        const { message, sessionId, cwd, permissionMode, model, attachments, openedFiles } = stdinData;
        await claudeSendMessageWithAttachments(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          attachments ? { attachments, openedFiles } : { openedFiles }
        );
      } else {
        await claudeSendMessageWithAttachments(args[0], args[1], args[2], args[3], args[4], stdinData);
      }
      break;
    }

    case 'getSession':
      await claudeGetSessionMessages(args[0], args[1]);
      break;

    default:
      throw new Error(`Unknown Claude command: ${command}`);
  }
}

/**
 * Codex 命令处理 (暂时禁用 - SDK 已卸载)
 */
async function handleCodexCommand(command, args, stdinData) {
  throw new Error('Codex support is temporarily disabled. SDK not installed.');
}

// 执行命令
(async () => {
  try {
    // 验证 provider
    if (!provider || !['claude', 'codex'].includes(provider)) {
      console.error('Invalid provider. Use "claude" or "codex"');
      console.log(JSON.stringify({
        success: false,
        error: 'Invalid provider: ' + provider
      }));
      process.exit(1);
    }

    // 验证 command
    if (!command) {
      console.error('No command specified');
      console.log(JSON.stringify({
        success: false,
        error: 'No command specified'
      }));
      process.exit(1);
    }

    // 读取 stdin 数据
    const stdinData = await readStdinData(provider);

    // 根据 provider 分发
    if (provider === 'claude') {
      await handleClaudeCommand(command, args, stdinData);
    } else if (provider === 'codex') {
      await handleCodexCommand(command, args, stdinData);
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
