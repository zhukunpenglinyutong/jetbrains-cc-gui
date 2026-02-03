/**
 * Attachment handling service module.
 * Responsible for loading and processing attachments.
 */

import fs from 'fs';

/**
 * 读取附件 JSON（通过环境变量 CLAUDE_ATTACHMENTS_FILE 指定路径）
 * @deprecated 使用 loadAttachmentsFromStdin 替代，避免文件 I/O
 */
export function loadAttachmentsFromEnv() {
  try {
    const filePath = process.env.CLAUDE_ATTACHMENTS_FILE;
    if (!filePath) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (e) {
    console.error('[ATTACHMENTS] Failed to load attachments:', e.message);
    return [];
  }
}

/**
 * 从 stdin 读取附件数据（异步）
 * Java 端通过 stdin 发送 JSON 格式的附件数组，避免临时文件
 * 格式: { "attachments": [...], "message": "用户消息" }
 */
export async function readStdinData() {
  return new Promise((resolve) => {
    // 检查是否有环境变量标记表示使用 stdin
    if (process.env.CLAUDE_USE_STDIN !== 'true') {
      resolve(null);
      return;
    }

    let data = '';
    const stdin = process.stdin;

    // 清理函数：移除所有监听器并停止读取
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause();
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 5000); // 5秒超时

    const onData = (chunk) => {
      data += chunk;
    };

    const onEnd = () => {
      clearTimeout(timeout);
      cleanup();
      if (data.trim()) {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          console.error('[STDIN] Failed to parse stdin JSON:', e.message);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };

    const onError = (err) => {
      clearTimeout(timeout);
      cleanup();
      console.error('[STDIN] Error reading stdin:', err.message);
      resolve(null);
    };

    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);

    // 开始读取
    stdin.resume();
  });
}

/**
 * 从 stdin 或环境变量文件加载附件（兼容两种方式）
 * 优先使用 stdin，如果没有则回退到文件方式
 *
 * 支持的 stdinData 格式：
 * 1. 直接数组格式: [{fileName, mediaType, data}, ...]
 * 2. 包装对象格式: { attachments: [...] }
 */
export async function loadAttachments(stdinData) {
  // 优先使用 stdin 传入的数据
  if (stdinData) {
    // 格式1: 直接数组格式 (Java 端发送)
    if (Array.isArray(stdinData)) {
      return stdinData;
    }
    // 格式2: 包装对象格式
    if (Array.isArray(stdinData.attachments)) {
      return stdinData.attachments;
    }
  }

  // 回退到文件方式（兼容旧版本）
  return loadAttachmentsFromEnv();
}

/**
 * 构建用户消息内容块（支持图片和文本）
 * @param {Array} attachments - 附件数组
 * @param {string} message - 用户消息文本
 * @returns {Array} 内容块数组
 */
export function buildContentBlocks(attachments, message) {
  const contentBlocks = [];

  // 添加图片块
  for (const a of attachments) {
    const mt = typeof a.mediaType === 'string' ? a.mediaType : '';
    if (mt.startsWith('image/')) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mt || 'image/png',
          data: a.data
        }
      });
    } else {
      // 非图片附件作为文本提示
      const name = a.fileName || 'Attachment';
      contentBlocks.push({ type: 'text', text: `[Attachment: ${name}]` });
    }
  }

  // 处理空消息情况
  let userText = message;
  if (!userText || userText.trim() === '') {
    const imageCount = contentBlocks.filter(b => b.type === 'image').length;
    const textCount = contentBlocks.filter(b => b.type === 'text').length;
    if (imageCount > 0) {
      userText = `[Uploaded ${imageCount} image(s)]`;
    } else if (textCount > 0) {
      userText = `[Uploaded attachment(s)]`;
    } else {
      userText = '[Empty message]';
    }
  }

  // 添加用户文本
  contentBlocks.push({ type: 'text', text: userText });

  return contentBlocks;
}
