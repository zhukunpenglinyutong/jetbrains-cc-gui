/**
 * stdin 读取工具模块（统一版）
 * 支持 Claude 和 Codex 两种 SDK
 */

/**
 * 从 stdin 读取 JSON 数据
 * @param {string} provider - 'claude' 或 'codex'
 * @returns {Promise<Object|null>} 解析后的 JSON 对象，或 null
 */
export async function readStdinData(provider = 'claude') {
  // 检查是否启用了 stdin 输入
  const envKey = provider === 'codex' ? 'CODEX_USE_STDIN' : 'CLAUDE_USE_STDIN';
  if (process.env[envKey] !== 'true') {
    return null;
  }

  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;

    stdin.setEncoding('utf8');

    // 设置超时，避免无限等待
    const timeout = setTimeout(() => {
      resolve(null);
    }, 5000);

    stdin.on('readable', () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        data += chunk;
      }
    });

    stdin.on('end', () => {
      clearTimeout(timeout);
      if (data.trim()) {
        try {
          const parsed = JSON.parse(data.trim());
          resolve(parsed);
        } catch (e) {
          console.error('[STDIN_PARSE_ERROR]', e.message);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });

    stdin.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[STDIN_ERROR]', err.message);
      resolve(null);
    });
  });
}
