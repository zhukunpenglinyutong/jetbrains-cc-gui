#!/usr/bin/env node

/**
 * 简单的 Claude Agent SDK 测试脚本
 * 用于测试 Java 与 Claude SDK 的交互
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// 从命令行参数获取提示词，如果没有则使用默认值
const userPrompt = process.argv[2] || 'Hello, what is 2+2?';

console.log('Starting Claude Agent SDK test...');
console.log('Prompt:', userPrompt);
console.log('---');

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

async function runQuery() {
  try {
    // 加载 Claude Code 配置
    const settings = loadClaudeSettings();

    // 检查 API Key - 支持多种来源
    let apiKey = process.env.ANTHROPIC_API_KEY;
    let baseUrl = process.env.ANTHROPIC_BASE_URL;

    // 如果环境变量没有，尝试从 Claude Code 配置读取
    if (!apiKey && settings?.env?.ANTHROPIC_AUTH_TOKEN) {
      apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
      console.log('✓ 从 ~/.claude/settings.json 读取 ANTHROPIC_AUTH_TOKEN');
    }

    if (!baseUrl && settings?.env?.ANTHROPIC_BASE_URL) {
      baseUrl = settings.env.ANTHROPIC_BASE_URL;
      console.log('✓ 从 ~/.claude/settings.json 读取 ANTHROPIC_BASE_URL:', baseUrl);
    }

    if (!apiKey) {
      console.error('⚠️  警告: API Key 未配置');
      console.error('请先配置 API Key:');
      console.error('  方式1: export ANTHROPIC_API_KEY=your_key');
      console.error('  方式2: 运行 claude login');
      console.error('  方式3: 在 ~/.claude/settings.json 配置');
      console.log('[JSON_START]');
      console.log(JSON.stringify({
        success: false,
        error: 'API Key not configured'
      }));
      console.log('[JSON_END]');
      process.exit(1);
    }

    // 设置环境变量，让 SDK 使用
    process.env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) {
      process.env.ANTHROPIC_BASE_URL = baseUrl;
    }

    console.log('✓ API Key 已设置');
    if (baseUrl) {
      console.log('✓ Base URL:', baseUrl);
    }
    console.log('✓ 开始查询...');

    // 创建一个查询，添加超时控制
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      console.error('\n⚠️  查询超时 (30秒)');
      abortController.abort();
    }, 30000);

    const result = query({
      prompt: userPrompt,
      options: {
        // 使用更简单的配置
        permissionMode: 'bypassPermissions', // 绕过权限检查，方便测试
        model: 'sonnet', // 使用 Sonnet 模型
        maxTurns: 1, // 限制为1轮对话，快速测试
        // 不加载任何文件系统设置
        settingSources: [],
        abortController: abortController
      }
    });

    clearTimeout(timeout);

    // 收集所有消息
    const messages = [];

    // 迭代所有返回的消息
    for await (const message of result) {
      messages.push(message);

      // 实时输出消息类型
      console.log(`[Message Type: ${message.type}]`);

      // 如果是助手消息，输出内容
      if (message.type === 'assistant') {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log('[Assistant]:', block.text);
            }
          }
        }
      }

      // 如果是结果消息，输出统计信息
      if (message.type === 'result') {
        console.log('---');
        console.log('[Result]');
        console.log('Success:', message.subtype === 'success');
        console.log('Turns:', message.num_turns);
        console.log('Cost:', `$${message.total_cost_usd.toFixed(4)}`);
        console.log('Tokens:', {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens
        });
      }
    }

    // 输出 JSON 格式的完整结果（方便 Java 解析）
    console.log('---');
    console.log('[JSON_START]');
    console.log(JSON.stringify({
      success: true,
      messageCount: messages.length,
      messages: messages
    }, null, 2));
    console.log('[JSON_END]');

  } catch (error) {
    console.error('\n❌ 错误:', error.message);

    // 检查常见错误
    if (error.message.includes('API key')) {
      console.error('\n提示: API Key 问题');
      console.error('  1. 检查 ANTHROPIC_API_KEY 是否正确设置');
      console.error('  2. 或运行: claude login');
    } else if (error.message.includes('network') || error.message.includes('ECONNREFUSED')) {
      console.error('\n提示: 网络连接问题');
      console.error('  1. 检查网络连接');
      console.error('  2. 检查是否需要代理');
    }

    console.log('[JSON_START]');
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }, null, 2));
    console.log('[JSON_END]');
    process.exit(1);
  }
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('\n❌ 未捕获的异常:', error.message);
  console.log('[JSON_START]');
  console.log(JSON.stringify({
    success: false,
    error: 'Uncaught exception: ' + error.message
  }));
  console.log('[JSON_END]');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ 未处理的 Promise 拒绝:', reason);
  console.log('[JSON_START]');
  console.log(JSON.stringify({
    success: false,
    error: 'Unhandled rejection: ' + reason
  }));
  console.log('[JSON_END]');
  process.exit(1);
});

// 运行查询
runQuery();
