import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import {
  getMessageKey,
  getContentBlocks,
  mergeConsecutiveAssistantMessages,
  formatCommandForDisplay,
  formatCommandForResubmit,
  formatTaskNotificationForDisplay,
  hasCommandMessageTag,
  hasTaskNotificationTag,
  isTaskNotificationOnlyMessage,
  isSyntheticToolMessageContent,
  hasNonHumanOrigin,
  shouldShowMessage,
  TASK_STATUS_COLORS,
} from './messageUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (
  type: ClaudeMessage['type'],
  content: string,
  extra?: Partial<ClaudeMessage>,
): ClaudeMessage => ({
  type,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

// ---------------------------------------------------------------------------
// getMessageKey — __turnId support
// ---------------------------------------------------------------------------

describe('getMessageKey', () => {
  it('returns uuid when present', () => {
    const msg = makeMsg('assistant', 'hello', { raw: { uuid: 'abc-123' } as any });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns uuid even when __turnId is also present', () => {
    const msg = makeMsg('assistant', 'hello', {
      raw: { uuid: 'abc-123' } as any,
      __turnId: 5,
    });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns __turnId-based key when uuid is absent', () => {
    const msg = makeMsg('assistant', 'hello', { __turnId: 3 });
    expect(getMessageKey(msg, 0)).toBe('turn-3');
  });

  it('falls back to type-timestamp when both uuid and __turnId are absent', () => {
    const ts = '2024-01-01T00:00:00Z';
    const msg = makeMsg('user', 'hello', { timestamp: ts });
    expect(getMessageKey(msg, 0)).toBe(`user-${ts}`);
  });

  it('falls back to type-index when no uuid, __turnId, or timestamp', () => {
    const msg: ClaudeMessage = { type: 'assistant', content: 'hi' };
    expect(getMessageKey(msg, 7)).toBe('assistant-7');
  });
});

// ---------------------------------------------------------------------------
// getContentBlocks — synthetic tool content filtering
// ---------------------------------------------------------------------------

describe('getContentBlocks', () => {
  const normalizeBlocks = (raw: any) => raw?.content ?? null;
  const localizeMessage = (text: string) => text;

  it('does not append synthetic Tool content for tool-only messages', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Tool: shell_command',
      raw: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } },
        ],
      } as any,
    };

    const result = getContentBlocks(message, normalizeBlocks, localizeMessage);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
  });

  it('does not append repeated synthetic Tool content for merged tool-only messages', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Tool: shell_command\nTool: shell_command',
      raw: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } },
          { type: 'tool_use', id: 'tool-2', name: 'shell_command', input: { command: 'git diff' } },
        ],
      } as any,
    };

    const result = getContentBlocks(message, normalizeBlocks, localizeMessage);

    expect(result).toHaveLength(2);
    expect(result.every((block) => block.type === 'tool_use')).toBe(true);
  });

  it('still appends real fallback content when raw has only tool blocks', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: '命令已经执行完成。',
      raw: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } },
        ],
      } as any,
    };

    const result = getContentBlocks(message, normalizeBlocks, localizeMessage);

    expect(result.map((block) => block.type)).toEqual(['tool_use', 'text']);
    expect((result[1] as any).text).toBe('命令已经执行完成。');
  });
});

describe('isSyntheticToolMessageContent', () => {
  it('requires a tool_use block', () => {
    expect(isSyntheticToolMessageContent('Tool: shell_command', [{ type: 'text', text: 'x' }])).toBe(false);
  });

  it('matches single and repeated synthetic tool titles', () => {
    const blocks = [{ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: {} }] as any;

    expect(isSyntheticToolMessageContent('Tool: shell_command', blocks)).toBe(true);
    expect(isSyntheticToolMessageContent('Tool: shell_command\nTool: apply_patch', blocks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeConsecutiveAssistantMessages — __turnId preservation
// ---------------------------------------------------------------------------

describe('mergeConsecutiveAssistantMessages', () => {
  const normalizeBlocks = (raw: unknown): any[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as any;
    const blocks = r.content ?? r.message?.content;
    return Array.isArray(blocks) ? blocks : [];
  };

  it('preserves __turnId from first message in merged group', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBe(2);
  });

  it('does not add __turnId when first message has none', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBeUndefined();
  });

  it('does not merge across user messages', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'a1', { __turnId: 1 }),
      makeMsg('user', 'q'),
      makeMsg('assistant', 'a2', { __turnId: 2 }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(3);
    expect(result[0].__turnId).toBe(1);
    expect(result[2].__turnId).toBe(2);
  });

  it('does not merge assistant messages from different turns', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'first turn answer', {
        __turnId: 10,
        raw: { content: [{ type: 'text', text: 'first turn answer' }] } as any,
      }),
      makeMsg('assistant', 'second turn answer', {
        __turnId: 11,
        raw: { content: [{ type: 'text', text: 'second turn answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result.map((message) => message.__turnId)).toEqual([10, 11]);
  });

  it('does not merge streaming message (has __turnId) with history message (no __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'streaming turn', {
        __turnId: 5,
        raw: { content: [{ type: 'text', text: 'streaming turn' }] } as any,
      }),
      makeMsg('assistant', 'history message', {
        raw: { content: [{ type: 'text', text: 'history message' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result[0].__turnId).toBe(5);
    expect(result[1].__turnId).toBeUndefined();
  });

  it('does not merge history message (no __turnId) with streaming message (has __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'history message', {
        raw: { content: [{ type: 'text', text: 'history message' }] } as any,
      }),
      makeMsg('assistant', 'streaming turn', {
        __turnId: 5,
        raw: { content: [{ type: 'text', text: 'streaming turn' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result[0].__turnId).toBeUndefined();
    expect(result[1].__turnId).toBe(5);
  });

  it('merges history messages without __turnId together', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('part1\npart2');
  });

  it('merges tool-only assistant messages across user tool_result boundaries', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } as any,
      }),
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-2', name: 'shell_command', input: { command: 'git diff --cached' } }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);

    expect(result).toHaveLength(1);
    const mergedRaw = result[0].raw as { content?: Array<{ type?: string; id?: string }> };
    expect(mergedRaw.content?.filter((block) => block.type === 'tool_use').map((block) => block.id)).toEqual(['tool-1', 'tool-2']);
  });

  // ---------------------------------------------------------------------------
  // hasToolUse + __turnId absence — tool_use merging behavior
  // ---------------------------------------------------------------------------

  it('merges tool_use with final answer for history messages (no __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file' }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] } as any,
      }),
      makeMsg('assistant', 'final answer', {
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    const mergedRaw = result[0].raw as { content?: Array<{ type?: string }> };
    expect(mergedRaw.content?.some((b) => b.type === 'tool_use')).toBe(true);
    expect(mergedRaw.content?.some((b) => b.type === 'text')).toBe(true);
  });

  it('keeps tool_use separated from final answer for streaming messages (has __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        __turnId: 1,
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file' }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] } as any,
      }),
      makeMsg('assistant', 'final answer', {
        __turnId: 1,
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    // Should have 2 assistant messages: tool_use block and final answer block
    // (user tool_result is skipped, but assistant blocks stay separated)
    expect(result.filter((m) => m.type === 'assistant')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatCommandForDisplay — CLI-aligned command message rendering
// ---------------------------------------------------------------------------

describe('formatCommandForDisplay', () => {
  it('returns null for text without command-message tag', () => {
    expect(formatCommandForDisplay('hello world')).toBeNull();
    expect(formatCommandForDisplay('<command-name>/clear</command-name>')).toBeNull();
  });

  it('returns Skill format when skill-format=true', () => {
    const text = '<command-message>opsx:ff</command-message><skill-format>true</skill-format>';
    expect(formatCommandForDisplay(text)).toBe('Skill(opsx:ff)');
  });

  it('returns Skill format with skill-format and no args', () => {
    const text = '<command-message>init</command-message>\n<skill-format>true</skill-format>';
    expect(formatCommandForDisplay(text)).toBe('Skill(init)');
  });

  it('returns slash format without skill-format', () => {
    const text = '<command-message>opsx:ff</command-message>';
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff');
  });

  it('returns slash format with args', () => {
    const text = '<command-message>opsx:ff</command-message><command-args>hello there</command-args>';
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff hello there');
  });

  it('returns slash format without args when command-args is empty', () => {
    const text = '<command-message>clear</command-message><command-args></command-args>';
    expect(formatCommandForDisplay(text)).toBe('/clear');
  });

  it('handles multiline XML content', () => {
    const text = `<command-message>opsx:ff</command-message>
<command-args>hello world</command-args>`;
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff hello world');
  });

  it('trims whitespace from extracted content', () => {
    const text = '<command-message>  opsx:ff  </command-message><command-args>  hello  </command-args>';
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff hello');
  });
});

// ---------------------------------------------------------------------------
// formatCommandForResubmit — CLI-aligned copy/resubmit behavior
// ---------------------------------------------------------------------------

describe('formatCommandForResubmit', () => {
  it('returns null for text without command-name tag', () => {
    expect(formatCommandForResubmit('hello world')).toBeNull();
    expect(formatCommandForResubmit('<command-message>opsx:ff</command-message>')).toBeNull();
  });

  it('returns command-name with args', () => {
    const text = '<command-name>/opsx:ff</command-name><command-args>hello</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/opsx:ff hello');
  });

  it('returns command-name without args', () => {
    const text = '<command-name>/clear</command-name>';
    expect(formatCommandForResubmit(text)).toBe('/clear');
  });

  it('command-name already contains the / prefix', () => {
    const text = '<command-name>/review</command-name><command-args>code</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/review code');
  });

  it('handles multiline XML content', () => {
    const text = `<command-name>/opsx:ff</command-name>
<command-args>hello world</command-args>`;
    expect(formatCommandForResubmit(text)).toBe('/opsx:ff hello world');
  });
});

// ---------------------------------------------------------------------------
// formatTaskNotificationForDisplay — CLI-aligned task notification rendering
// ---------------------------------------------------------------------------

describe('formatTaskNotificationForDisplay', () => {
  it('returns null for text without summary tag', () => {
    expect(formatTaskNotificationForDisplay('<task-notification><status>completed</status></task-notification>')).toBeNull();
    expect(formatTaskNotificationForDisplay('hello world')).toBeNull();
  });

  it('returns ● summary with completed status', () => {
    const text = '<task-notification><status>completed</status><summary>Review finished</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Review finished',
      status: 'completed',
    });
  });

  it('returns ● summary with failed status', () => {
    const text = '<task-notification><status>failed</status><summary>Connection error</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Connection error',
      status: 'failed',
    });
  });

  it('returns ● summary with killed status', () => {
    const text = '<task-notification><status>killed</status><summary>User cancelled</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'User cancelled',
      status: 'killed',
    });
  });

  it('defaults to completed status when status tag missing', () => {
    const text = '<task-notification><summary>Task done</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Task done',
      status: 'completed',
    });
  });

  it('trims whitespace from summary', () => {
    const text = '<task-notification><status>completed</status><summary>  Task done  </summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result?.summary).toBe('Task done');
  });

  it('handles actual SDK format with task-id, result, usage tags', () => {
    // Actual SDK format from JSONL: task-id, tool-use-id, output-file, status, summary, result, usage
    const text = `<task-notification>
<task-id>a31e69ffd788b2055</task-id>
<tool-use-id>toolu_tool-62921666a9104a878d13f7aa038f05af</tool-use-id>
<output-file>C:\\Users\\test\\output.file</output-file>
<status>completed</status>
<summary>Agent "分析仓库结构" completed</summary>
<result>## 仓库分析报告\n\n详细内容...</result>
<usage><total_tokens>19874</total_tokens><tool_uses>12</tool_uses><duration_ms>19665</duration_ms></usage>
</task-notification>`;
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Agent "分析仓库结构" completed',
      status: 'completed',
    });
  });
});

// ---------------------------------------------------------------------------
// TASK_STATUS_COLORS — status color mapping
// ---------------------------------------------------------------------------

describe('TASK_STATUS_COLORS', () => {
  it('maps completed to success', () => {
    expect(TASK_STATUS_COLORS['completed']).toBe('success');
  });

  it('maps failed to error', () => {
    expect(TASK_STATUS_COLORS['failed']).toBe('error');
  });

  it('maps killed to warning', () => {
    expect(TASK_STATUS_COLORS['killed']).toBe('warning');
  });

  it('maps stopped to text', () => {
    expect(TASK_STATUS_COLORS['stopped']).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Tag detection helpers
// ---------------------------------------------------------------------------

describe('hasCommandMessageTag', () => {
  it('returns true for text with command-message tag', () => {
    expect(hasCommandMessageTag('<command-message>test</command-message>')).toBe(true);
  });

  it('returns false for text without command-message tag', () => {
    expect(hasCommandMessageTag('<command-name>/test</command-name>')).toBe(false);
    expect(hasCommandMessageTag('hello world')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(hasCommandMessageTag('')).toBe(false);
    expect(hasCommandMessageTag(null as any)).toBe(false);
  });
});

describe('hasTaskNotificationTag', () => {
  it('returns true for text with task-notification tag', () => {
    expect(hasTaskNotificationTag('<task-notification><status>completed</status></task-notification>')).toBe(true);
  });

  it('returns false for text without task-notification tag', () => {
    expect(hasTaskNotificationTag('hello world')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(hasTaskNotificationTag('')).toBe(false);
    expect(hasTaskNotificationTag(null as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTaskNotificationOnlyMessage — detect task-notification user messages
// ---------------------------------------------------------------------------

describe('isTaskNotificationOnlyMessage', () => {
  it('returns false for non-user messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: '<task-notification><summary>done</summary></task-notification>',
      timestamp: '1',
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(false);
  });

  it('returns true when message.content has task-notification tag', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '<task-notification><status>completed</status><summary>done</summary></task-notification>',
      timestamp: '1',
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns true when raw.content array has task-notification text block', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        content: [
          { type: 'text', text: '<task-notification><summary>task done</summary></task-notification>' },
        ],
      },
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns true when raw.message.content string has task-notification', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        message: {
          content: '<task-notification><summary>hello</summary></task-notification>',
        },
      },
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns true when raw.message.content array has task-notification', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        message: {
          content: [
            { type: 'text', text: '<task-notification><summary>hey</summary></task-notification>' },
          ],
        },
      },
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns false when no task-notification tag found', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hello world',
      timestamp: '1',
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(false);
  });

  it('returns false when raw is undefined', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'normal message',
      timestamp: '1',
      raw: undefined,
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasNonHumanOrigin — detect synthetic messages via origin.kind
// ---------------------------------------------------------------------------

describe('hasNonHumanOrigin', () => {
  it('returns false for non-user messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: 'hello',
      timestamp: '1',
      raw: { origin: { kind: 'task-notification' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });

  it('returns true for user message with origin.kind = task-notification', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'notification',
      timestamp: '1',
      raw: { origin: { kind: 'task-notification' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(true);
  });

  it('returns true for user message with origin.kind = hook', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hook msg',
      timestamp: '1',
      raw: { origin: { kind: 'hook' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(true);
  });

  it('returns false for user message with origin.kind = human', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hi',
      timestamp: '1',
      raw: { origin: { kind: 'human' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });

  it('returns false when raw has no origin field', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hi',
      timestamp: '1',
      raw: { content: 'hi' },
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });

  it('returns false when raw is undefined', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hi',
      timestamp: '1',
      raw: undefined,
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldShowMessage — message visibility filtering
// ---------------------------------------------------------------------------

describe('shouldShowMessage', () => {
  const mockGetMessageText = (msg: ClaudeMessage) => msg.content || '';
  const mockNormalizeBlocks = () => null;
  const mockT = ((key: string) => key) as any;

  it('filters toolUseResult messages', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'some content',
      timestamp: '1',
      raw: { toolUseResult: true },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(false);
  });

  it('filters isCompactSummary messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: 'summary content',
      timestamp: '1',
      raw: { isCompactSummary: true },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(false);
  });

  it('does not filter messages without toolUseResult or isCompactSummary', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'normal message',
      timestamp: '1',
      raw: { content: 'normal message' },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(true);
  });

  it('filters isMeta messages', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'meta content',
      timestamp: '1',
      raw: { isMeta: true },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(false);
  });
});

