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
