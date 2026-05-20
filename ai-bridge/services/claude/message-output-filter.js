const MAX_TOOL_RESULT_CONTENT_CHARS = 20000;
const ERROR_CONTENT_PREFIXES = ['API Error', 'API error', 'Error:', 'Error '];

export { MAX_TOOL_RESULT_CONTENT_CHARS, ERROR_CONTENT_PREFIXES };

export function truncateString(str, maxLen = 1000) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... [truncated, total ${str.length} chars]`;
}

// Patterns covering common credential shapes that can leak through SDK
// stderr / stack traces. Each entry pairs a regex with its replacement string.
// Patterns that need to preserve a leading label (Bearer, Authorization:, etc.)
// use a $1 capture-group reference; bare token patterns substitute the entire
// match. NOTE: ordering matters — longest-prefix variants (sk-ant-, sk-proj-)
// come before the generic sk-/pk-/rk- catch-all so the label is preserved.
const SECRET_PATTERNS = [
  // Anthropic / OpenAI / similar
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replacement: 'sk-ant-***REDACTED***' },
  { re: /\bsk-proj-[A-Za-z0-9_-]{16,}/g, replacement: 'sk-proj-***REDACTED***' },
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, replacement: '***REDACTED***' },
  // GitHub tokens
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replacement: '***REDACTED***' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: 'github_pat_***REDACTED***' },
  // Authorization / Bearer / x-api-key / api_key headers (preserve the label)
  { re: /(Bearer\s+)[A-Za-z0-9._\-+/=]{16,}/gi, replacement: '$1***REDACTED***' },
  { re: /(Authorization\s*[:=]\s*)[^\s"'\n,;]{16,}/gi, replacement: '$1***REDACTED***' },
  { re: /(x-api-key\s*[:=]\s*)[^\s"'\n,;]{16,}/gi, replacement: '$1***REDACTED***' },
  { re: /(api[_-]?key\s*[:=]\s*["']?)[^"'\s\n,;]{16,}/gi, replacement: '$1***REDACTED***' },
];

export function redactSecrets(value) {
  if (value == null) return value;
  let text = typeof value === 'string' ? value : String(value);
  for (const { re, replacement } of SECRET_PATTERNS) {
    text = text.replace(re, replacement);
  }
  return text;
}

export function truncateErrorContent(content, maxLen = 1000) {
  if (!content || content.length <= maxLen) return content;
  const isError = ERROR_CONTENT_PREFIXES.some(prefix => content.startsWith(prefix));
  if (!isError) return content;
  return content.substring(0, maxLen) + `... [truncated, total ${content.length} chars]`;
}

export function truncateToolResultBlock(block) {
  if (!block || !block.content) return block;
  const content = block.content;
  if (typeof content === 'string' && content.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
    const head = Math.floor(MAX_TOOL_RESULT_CONTENT_CHARS * 0.65);
    const tail = MAX_TOOL_RESULT_CONTENT_CHARS - head;
    return {
      ...block,
      content: content.substring(0, head) +
        `\n...\n(truncated, original length: ${content.length} chars)\n...\n` +
        content.substring(content.length - tail)
    };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const truncated = content.map(item => {
      if (item && item.type === 'text' && typeof item.text === 'string' && item.text.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
        changed = true;
        const head = Math.floor(MAX_TOOL_RESULT_CONTENT_CHARS * 0.65);
        const tail = MAX_TOOL_RESULT_CONTENT_CHARS - head;
        return {
          ...item,
          text: item.text.substring(0, head) +
            `\n...\n(truncated, original length: ${item.text.length} chars)\n...\n` +
            item.text.substring(item.text.length - tail)
        };
      }
      return item;
    });
    return changed ? { ...block, content: truncated } : block;
  }
  return block;
}
