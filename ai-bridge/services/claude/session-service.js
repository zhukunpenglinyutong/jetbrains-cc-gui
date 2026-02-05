/**
 * 会话管理服务模块
 * 负责会话的持久化和历史消息管理
 */

import fs from 'fs';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getClaudeDir } from '../../utils/path-utils.js';

/**
 * 将一条消息追加到 JSONL 历史文件
 * 添加必要的元数据字段以确保与历史记录读取器兼容
 */
export function persistJsonlMessage(sessionId, cwd, obj) {
  try {
    const projectsDir = join(getClaudeDir(), 'projects');
    const sanitizedCwd = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
    const projectHistoryDir = join(projectsDir, sanitizedCwd);
    fs.mkdirSync(projectHistoryDir, { recursive: true });
    const sessionFile = join(projectHistoryDir, `${sessionId}.jsonl`);

    // 添加必要的元数据字段以确保与 ClaudeHistoryReader 兼容
    const enrichedObj = {
      ...obj,
      uuid: randomUUID(),
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    };

    fs.appendFileSync(sessionFile, JSON.stringify(enrichedObj) + '\n', 'utf8');
    console.log('[PERSIST] Message saved to:', sessionFile);
  } catch (e) {
    console.error('[PERSIST_ERROR]', e.message);
  }
}

/**
 * 加载会话历史消息（用于恢复会话时维护上下文）
 * 返回 Anthropic Messages API 格式的消息数组
 */
export function loadSessionHistory(sessionId, cwd) {
  try {
    const projectsDir = join(getClaudeDir(), 'projects');
    const sanitizedCwd = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
    const sessionFile = join(projectsDir, sanitizedCwd, `${sessionId}.jsonl`);

    if (!fs.existsSync(sessionFile)) {
      return [];
    }

    const content = fs.readFileSync(sessionFile, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'user' && msg.message && msg.message.content) {
          messages.push({
            role: 'user',
            content: msg.message.content
          });
        } else if (msg.type === 'assistant' && msg.message && msg.message.content) {
          messages.push({
            role: 'assistant',
            content: msg.message.content
          });
        }
      } catch (e) {
        // 跳过解析失败的行
      }
    }

    // 排除最后一条用户消息（因为我们在调用此函数前已经持久化了当前用户消息）
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      messages.pop();
    }

    return messages;
  } catch (e) {
    console.error('[LOAD_HISTORY_ERROR]', e.message);
    return [];
  }
}

/**
 * 获取会话历史消息
 * 从 ~/.claude/projects/ 目录读取
 */
export async function getSessionMessages(sessionId, cwd = null) {
  try {
    const projectsDir = join(getClaudeDir(), 'projects');

    // 转义项目路径（与 ClaudeSessionService.ts 相同逻辑）
    const sanitizedCwd = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
    const projectHistoryDir = join(projectsDir, sanitizedCwd);

    // 会话文件路径
    const sessionFile = join(projectHistoryDir, `${sessionId}.jsonl`);

    if (!existsSync(sessionFile)) {
      console.log(JSON.stringify({
        success: false,
        error: 'Session file not found'
      }));
      return;
    }

    // 读取 JSONL 文件
    const content = await readFile(sessionFile, 'utf8');
    const messages = content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(msg => msg !== null);

    console.log(JSON.stringify({
      success: true,
      messages
    }));

  } catch (error) {
    console.error('[GET_SESSION_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  }
}
