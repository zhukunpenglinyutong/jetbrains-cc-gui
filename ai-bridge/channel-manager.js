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
import { getSdkStatus, isClaudeSdkAvailable, isCodexSdkAvailable } from './utils/sdk-loader.js';

// 🔧 诊断日志：启动信息
console.log('[DIAG-ENTRY] ========== CHANNEL-MANAGER STARTUP ==========');
console.log('[DIAG-ENTRY] Node.js version:', process.version);
console.log('[DIAG-ENTRY] Platform:', process.platform);
console.log('[DIAG-ENTRY] CWD:', process.cwd());
console.log('[DIAG-ENTRY] argv:', process.argv);

// 命令行参数解析
const provider = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

// 🔧 诊断日志：参数信息
console.log('[DIAG-ENTRY] Provider:', provider);
console.log('[DIAG-ENTRY] Command:', command);
console.log('[DIAG-ENTRY] Args:', args);

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
 * 处理系统级命令（如 SDK 状态检查）
 */
async function handleSystemCommand(command, args, stdinData) {
  switch (command) {
    case 'getSdkStatus':
      // 返回所有 SDK 的安装状态
      const status = getSdkStatus();
      console.log(JSON.stringify({
        success: true,
        data: status
      }));
      break;

    case 'checkClaudeSdk':
      // 检查 Claude SDK 是否可用
      console.log(JSON.stringify({
        success: true,
        available: isClaudeSdkAvailable()
      }));
      break;

    case 'checkCodexSdk':
      // 检查 Codex SDK 是否可用
      console.log(JSON.stringify({
        success: true,
        available: isCodexSdkAvailable()
      }));
      break;

    default:
      console.log(JSON.stringify({
        success: false,
        error: 'Unknown system command: ' + command
      }));
      process.exit(1);
  }
}

const providerHandlers = {
  claude: handleClaudeCommand,
  codex: handleCodexCommand,
  system: handleSystemCommand
};

// 执行命令
(async () => {
  console.log('[DIAG-EXEC] ========== STARTING EXECUTION ==========');
  try {
    // 验证 provider
    console.log('[DIAG-EXEC] Validating provider...');
    if (!provider || !providerHandlers[provider]) {
      console.error('Invalid provider. Use "claude", "codex", or "system"');
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
    console.log('[DIAG-EXEC] Reading stdin data...');
    const stdinData = await readStdinData(provider);
    console.log('[DIAG-EXEC] Stdin data received, keys:', stdinData ? Object.keys(stdinData) : 'null');

    // 根据 provider 分发
    console.log('[DIAG-EXEC] Dispatching to handler:', provider);
    const handler = providerHandlers[provider];
    await handler(command, args, stdinData);
    console.log('[DIAG-EXEC] Handler completed successfully');

    // 🔥 重要：不要使用 process.exit(0)，因为它会在 stdout 缓冲区刷新前终止进程
    // 导致大量 JSON 输出（如 getSession 返回的历史消息）被截断
    // 使用 process.exitCode 设置退出码，让进程自然退出，确保所有 I/O 完成
    process.exitCode = 0;

    // 🔥 对于 rewindFiles 命令，需要强制退出
    // 因为它会恢复 SDK 会话，会话的 MCP 连接可能保持打开状态，导致进程无法自然退出
    // rewindFiles 的输出很小，不会有截断问题
    if (command === 'rewindFiles') {
      // 给一点时间让 stdout 缓冲区刷新
      setTimeout(() => process.exit(0), 100);
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
