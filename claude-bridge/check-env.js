#!/usr/bin/env node

/**
 * 环境检查脚本
 * 检查 Claude SDK 运行所需的环境配置
 */

console.log('=== Claude SDK 环境检查 ===\n');

// 读取 Claude Code 配置
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function loadClaudeSettings() {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return settings;
  } catch (error) {
    return null;
  }
}

const settings = loadClaudeSettings();

// 1. 检查 Node.js 版本
console.log('1. Node.js 版本:');
console.log('   ' + process.version);
const nodeMajor = parseInt(process.version.slice(1).split('.')[0]);
if (nodeMajor >= 18) {
  console.log('   ✓ 版本满足要求 (需要 >= 18)');
} else {
  console.log('   ✗ 版本过低，需要 Node.js 18 或更高');
}
console.log();

// 2. 检查 SDK 是否安装
console.log('2. Claude Agent SDK:');
try {
  const pkg = await import('@anthropic-ai/claude-agent-sdk');
  console.log('   ✓ SDK 已安装');
  console.log('   可用函数:', Object.keys(pkg).join(', '));
} catch (error) {
  console.log('   ✗ SDK 未安装');
  console.log('   请运行: npm install');
}
console.log();

// 3. 检查 API Key
console.log('3. API Key 配置:');
let apiKey = process.env.ANTHROPIC_API_KEY;
let apiKeySource = 'ANTHROPIC_API_KEY 环境变量';

// 检查 Claude Code 配置
if (!apiKey && settings?.env?.ANTHROPIC_AUTH_TOKEN) {
  apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
  apiKeySource = '~/.claude/settings.json (ANTHROPIC_AUTH_TOKEN)';
}

if (apiKey) {
  console.log('   ✓ API Key 已设置');
  console.log('   来源:', apiKeySource);
  console.log('   长度:', apiKey.length, '字符');
  console.log('   前缀:', apiKey.substring(0, 10) + '...');
} else {
  console.log('   ✗ API Key 未设置');
  console.log('   请配置 API Key:');
  console.log('     export ANTHROPIC_API_KEY=your_key');
  console.log('   或运行: claude login');
}

// 检查 Base URL
if (settings?.env?.ANTHROPIC_BASE_URL) {
  console.log('   ✓ 自定义 Base URL:', settings.env.ANTHROPIC_BASE_URL);
}
console.log();

// 4. 检查 Claude Code CLI
console.log('4. Claude Code CLI:');
try {
  const { execSync } = await import('child_process');
  const version = execSync('claude --version', { encoding: 'utf8' }).trim();
  console.log('   ✓ Claude CLI 已安装:', version);
} catch (error) {
  console.log('   ✗ Claude CLI 未安装或不在 PATH 中');
  console.log('   (可选，但推荐安装)');
}
console.log();

// 5. 检查网络连接
console.log('5. 网络连接测试:');
try {
  const https = await import('https');
  const http = await import('http');

  // 检测使用哪个 URL
  const testUrl = settings?.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  console.log('   测试 URL:', testUrl);

  const isHttps = testUrl.startsWith('https://');
  const protocol = isHttps ? https : http;

  await new Promise((resolve, reject) => {
    const req = protocol.get(testUrl, (res) => {
      console.log('   ✓ 可以连接到服务器');
      console.log('   状态码:', res.statusCode);
      resolve();
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('连接超时'));
    });
  });
} catch (error) {
  console.log('   ✗ 无法连接到服务器');
  console.log('   错误:', error.message);
  console.log('   请检查网络连接或代理设置');
}
console.log();

// 总结
console.log('=== 检查完成 ===');
console.log();
if (apiKey) {
  console.log('✓ 环境配置正常，可以运行测试:');
  console.log('  node simple-query.js "你的问题"');
} else {
  console.log('⚠️  请先配置 API Key 后再运行测试');
}
