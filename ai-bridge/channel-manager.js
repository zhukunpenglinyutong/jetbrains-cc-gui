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
import { handleClaudeCommand } from './channels/claude-channel.js';
import { handleCodexCommand } from './channels/codex-channel.js';

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

const providerHandlers = {
  claude: handleClaudeCommand,
  codex: handleCodexCommand
};

// 执行命令
(async () => {
  try {
    // 验证 provider
    if (!provider || !providerHandlers[provider]) {
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
    const handler = providerHandlers[provider];
    await handler(command, args, stdinData);

  } catch (error) {
    console.error('[COMMAND_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
})();
