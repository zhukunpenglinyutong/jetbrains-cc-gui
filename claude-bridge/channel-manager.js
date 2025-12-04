#!/usr/bin/env node

/**
 * Claude Agent Channel Manager V2
 * 支持持久化 channel 的多轮对话（简化版）
 *
 * 命令:
 *   send - 发送消息（参数通过 stdin JSON 传递）
 *   sendWithAttachments - 发送带附件的消息（参数通过 stdin JSON 传递）
 *   getSession <sessionId> [cwd] - 获取会话历史消息
 *
 * 设计说明：
 * - 不维护全局状态（每次调用是独立进程）
 * - sessionId 由调用方（Java）维护
 * - 每次调用时通过 resume 参数恢复会话
 * - 消息和其他参数通过 stdin 以 JSON 格式传递，避免命令行特殊字符问题
 */

// 服务模块
import { sendMessage, sendMessageWithAttachments } from './services/message-service.js';
import { getSessionMessages } from './services/session-service.js';
import { readStdinData } from './services/attachment-service.js';

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
      case 'send': {
        // 从 stdin 读取参数（JSON 格式）
        const stdinData = await readStdinData();
        if (stdinData && stdinData.message !== undefined) {
          // 新方式：从 stdin 读取所有参数
          const { message, sessionId, cwd, permissionMode, model } = stdinData;
          await sendMessage(message, sessionId || '', cwd || '', permissionMode || '', model || '');
        } else {
          // 兼容旧方式：从命令行参数读取
          await sendMessage(args[0], args[1], args[2], args[3], args[4]);
        }
        break;
      }

      case 'sendWithAttachments': {
        // 从 stdin 读取参数和附件（JSON 格式）
        const stdinData = await readStdinData();
        if (stdinData && stdinData.message !== undefined) {
          // 新方式：从 stdin 读取所有参数
          const { message, sessionId, cwd, permissionMode, model, attachments } = stdinData;
          await sendMessageWithAttachments(
            message,
            sessionId || '',
            cwd || '',
            permissionMode || '',
            model || '',
            attachments ? { attachments } : null
          );
        } else {
          // 兼容旧方式：从命令行参数读取
          await sendMessageWithAttachments(args[0], args[1], args[2], args[3], args[4], stdinData);
        }
        break;
      }

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
