import type { ClaudeMessage } from '../types';

const TAB_AUTO_RENAME_MAX_CHARS = 10;
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

  const pathStrippedRaw = rawText
    .replace(FILE_URI_PATTERN, ' ')
    .replace(WINDOWS_PATH_PATTERN, ' ')
    .replace(POSIX_OR_RELATIVE_PATH_PATTERN, ' ');

  const sentenceSource = pathStrippedRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) || pathStrippedRaw.trim();
  const firstSentence = (sentenceSource.split(/[。！？!?；;]/)[0] || sentenceSource).trim();
  if (!firstSentence) return '';

  const briefMatch = firstSentence.match(/^需求简述[:：]\s*(.+)$/);
  const candidate = briefMatch ? briefMatch[1].trim() : firstSentence;
  if (!candidate) return '';

  const normalized = candidate.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  return getTruncatedTitle(normalized, TAB_AUTO_RENAME_MAX_CHARS);
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
