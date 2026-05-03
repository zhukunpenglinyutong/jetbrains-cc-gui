import type { ClaudeMessage } from '../types';

const TAB_AUTO_RENAME_MAX_CHARS = 10;
const TAB_AUTO_RENAME_PREFERRED_CHARS = 10;
export const MIN_MEANINGFUL_INPUT_CHARS = 8;

const CONTINUE_LIKE_INPUTS = new Set([
  '继续',
  '继续吧',
  '继续下',
  '继续一下',
  '接着',
  '接着做',
  '然后',
  '下一步',
  '继续处理',
  '继续改',
  '继续优化',
  'go on',
  'continue',
]);

const NOISE_PHRASES = [
  '你这个',
  '你帮我',
  '帮我',
  '帮忙',
  '麻烦你',
  '麻烦',
  '请你',
  '请',
  '我想',
  '我要',
  '给我',
  '实现一下',
  '实现下',
  '做一下',
  '做下',
  '处理一下',
  '处理下',
  '优化一下',
  '优化下',
  '修复一下',
  '修复下',
  '精简一下',
  '总结一下',
  '总结下',
  '解释一下',
  '解释下',
  '看一下',
  '看下',
];

const FILE_URI_PATTERN = /file:\/\/\/?[^\s，。！？；,;]+/gi;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\(?:[^\\\s，。！？；,;]+\\)*[^\\\s，。！？；,;]*/g;
const POSIX_OR_RELATIVE_PATH_PATTERN = /(?:\.{0,2}\/)?(?:[\w.-]+\/){2,}[\w.-]+/g;
const TOOL_RESULT_ONLY_PATTERN = /^\[tool_result\]$/i;
const AUTO_INJECTED_SECTION_MARKER = '## Auto Injected Prompt Instructions';
const AGENT_ROLE_SECTION_MARKER = '## Agent Role and Instructions';
const MESSAGE_PROMPT_SEPARATOR = '\n\n---\n\n';

function getTruncatedTitle(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const chars = Array.from(normalized);
  return chars.slice(0, maxChars).join('');
}

function getCompactTitle(input: string): string {
  const normalized = input.replace(/\s+/g, '').trim();
  if (!normalized) return '';

  const compactRules: Array<{ pattern: RegExp; title: string }> = [
    { pattern: /(约束|规则).*(是什么|有哪些|说明|总结|解释)|(是什么|有哪些|说明|总结|解释).*(约束|规则)/i, title: '约束说明' },
    { pattern: /(标题|标签页|tab).*(显示|省略|截断|宽度|竖线|ellipsis)|(显示|省略|截断|宽度|竖线|ellipsis).*(标题|标签页|tab)/i, title: '标题显示' },
    { pattern: /(全显示|显示完|省略号|三个点|截断|ellipsis|\.\.\.)/i, title: '显示省略' },
    { pattern: /(写|编写|新增|生成|整理).*(文档|说明|readme)|(文档|说明|readme).*(写|编写|新增|生成|整理)/i, title: '文档编写' },
    { pattern: /(标签|tab).*(重命名|改名|标题)|(重命名|改名|标题).*(标签|tab)/i, title: '标签改名' },
    { pattern: /(历史|history).*(补全|completion|自动补全)/i, title: '历史补全' },
    { pattern: /(设置|setting).*(开关|toggle)/i, title: '设置开关' },
    { pattern: /(报错|错误|异常|error).*(修复|解决|fix)/i, title: '报错修复' },
    { pattern: /(界面|ui|页面).*(优化|改版|调整)/i, title: '界面优化' },
    { pattern: /(性能|卡顿|慢|优化)/i, title: '性能优化' },
  ];
  for (const rule of compactRules) {
    if (rule.pattern.test(normalized)) {
      return rule.title;
    }
  }

  const stripped = normalized.replace(/[，。！？；：,.!?:;'"`()[\]{}【】<>《》]/g, '');
  if (!stripped) return '';
  return getTruncatedTitle(stripped, TAB_AUTO_RENAME_PREFERRED_CHARS);
}

function isPathLikeSegment(segment: string): boolean {
  const text = segment.trim();
  if (!text) return false;
  if (/[A-Za-z]:\\/.test(text)) return true;
  if (/file:\/\//i.test(text)) return true;
  const slashCount = (text.match(/[\\/]/g) || []).length;
  return slashCount >= 2;
}

export function stripPathLikeContent(input: string): string {
  return input
    .replace(FILE_URI_PATTERN, ' ')
    .replace(WINDOWS_PATH_PATTERN, ' ')
    .replace(POSIX_OR_RELATIVE_PATH_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanupHistorySessionTitle(input: string): string {
  const raw = (input || '').trim();
  if (!raw) {
    return raw;
  }

  const separatorIndex = raw.lastIndexOf(MESSAGE_PROMPT_SEPARATOR);
  if (separatorIndex >= 0) {
    const prefix = raw.slice(0, separatorIndex);
    if (
      prefix.includes(AUTO_INJECTED_SECTION_MARKER) ||
      prefix.includes(AGENT_ROLE_SECTION_MARKER)
    ) {
      const userPart = raw.slice(separatorIndex + MESSAGE_PROMPT_SEPARATOR.length).trim();
      if (userPart) {
        return userPart;
      }
    }
  }

  const cleaned = stripPathLikeContent(raw).replace(/\s+/g, ' ').trim();
  return cleaned || raw;
}

export function isContinueLikeInput(input: string): boolean {
  const normalized = input.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return false;
  if (CONTINUE_LIKE_INPUTS.has(normalized)) return true;
  return (
    normalized.startsWith('继续') ||
    normalized.startsWith('接着') ||
    normalized.startsWith('然后') ||
    normalized.startsWith('下一步')
  );
}

export function isMeaningfulRequirementInput(input: string): boolean {
  const normalized = stripPathLikeContent(input)
    .replace(/\s+/g, '')
    .toLowerCase();
  if (!normalized) return false;
  if (isContinueLikeInput(normalized)) return false;
  return Array.from(normalized).length >= MIN_MEANINGFUL_INPUT_CHARS;
}

export function summarizeRequirementTitle(input: string): string {
  const rawText = input.trim();
  if (!rawText) return '';

  let text = stripPathLikeContent(rawText);
  const intentText = text;

  for (const noise of NOISE_PHRASES) {
    text = text.replaceAll(noise, '');
  }
  text = stripPathLikeContent(text);
  text = text.replace(/\s+/g, ' ').trim();

  const hasDocumentContext = /(文档|文件|readme|markdown|\.md\b)/i.test(rawText) || /(文档|文件|readme|markdown|\.md\b)/i.test(text);
  const asksDocumentMeaning = /(什么意思|什么\s*意思|含义|讲了什么|解读|解释|看不懂)/i.test(rawText);
  const asksDocumentSummary = /(总结|概述|梳理|提炼|归纳)/i.test(rawText);
  const explicitlyMentionsDocMeaning = /(文档意思|文件意思)/i.test(rawText);
  if (hasDocumentContext && (asksDocumentMeaning || asksDocumentSummary || explicitlyMentionsDocMeaning)) {
    return '文档意思';
  }

  if (/(约束|规则)/i.test(intentText) && /(是什么|有哪些|说明|总结|解释)/i.test(intentText)) return '约束说明';
  if (/(标题|标签页|tab)/i.test(intentText) && /(显示|省略|截断|宽度|竖线|ellipsis)/i.test(intentText)) return '标题显示';
  if (/(全显示|显示完|省略号|三个点|截断|ellipsis|\.\.\.)/i.test(intentText)) return '显示省略';
  if (/(写|编写|新增|生成|整理)/i.test(intentText) && /(文档|说明|readme)/i.test(intentText)) return '文档编写';
  if (/(标签|tab)/i.test(intentText) && /(重命名|改名|标题)/i.test(intentText)) return '标签改名';
  if (/(历史|history)/i.test(intentText) && /(补全|completion|自动补全)/i.test(intentText)) return '历史补全';
  if (/(设置|setting)/i.test(intentText) && /(开关|toggle)/i.test(intentText)) return '设置开关';
  if (/(报错|错误|异常|error)/i.test(intentText) && /(修复|解决|fix)/i.test(intentText)) return '报错修复';
  if (/(报错|错误|异常|error)/i.test(intentText)) return '报错排查';
  if (/(界面|ui|页面)/i.test(intentText) && /(优化|改版|调整)/i.test(intentText)) return '界面优化';
  if (/(性能|卡顿|慢|优化)/i.test(intentText)) return '性能优化';

  const segments = text
    .split(/[，。！？；：,.!?:;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((segment) => !isPathLikeSegment(segment));
  const best = (segments.sort((a, b) => b.length - a.length)[0] || text).trim();
  if (!best) return '';

  const compact = getCompactTitle(best);
  if (!compact) return '';
  return getTruncatedTitle(compact, TAB_AUTO_RENAME_MAX_CHARS);
}

export function getLatestMeaningfulRequirementTitle(
  messages: ClaudeMessage[],
  getMessageText: (message: ClaudeMessage) => string
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') {
      continue;
    }
    const text = getMessageText(message);
    if (!text || !text.trim()) {
      continue;
    }
    if (TOOL_RESULT_ONLY_PATTERN.test(text.trim())) {
      continue;
    }
    if (!isMeaningfulRequirementInput(text)) {
      continue;
    }
    const summary = summarizeRequirementTitle(text);
    if (summary) {
      return summary;
    }
  }
  return null;
}

export function getLatestMeaningfulRequirementText(
  messages: ClaudeMessage[],
  getMessageText: (message: ClaudeMessage) => string
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') {
      continue;
    }
    const text = getMessageText(message);
    if (!text || !text.trim()) {
      continue;
    }
    if (TOOL_RESULT_ONLY_PATTERN.test(text.trim())) {
      continue;
    }
    if (!isMeaningfulRequirementInput(text)) {
      continue;
    }
    const normalized = stripPathLikeContent(text).replace(/\s+/g, ' ').trim();
    if (normalized) {
      return normalized;
    }
    const fallback = text.replace(/\s+/g, ' ').trim();
    if (fallback) {
      return fallback;
    }
  }
  return null;
}
