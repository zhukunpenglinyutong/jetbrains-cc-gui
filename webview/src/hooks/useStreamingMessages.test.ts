import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStreamingMessages } from './useStreamingMessages';
import type { ClaudeMessage } from '../types';

describe('useStreamingMessages', () => {
  it('keeps the more complete backend text block before a streamed tool boundary', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current =
      '看到截图了，你只需要"总耗时 0:10"这部分，不要"最终消息"文案。先看参考项目的实现。先看参考项目里耗时的实现。';
    result.current.streamingTextSegmentsRef.current = [
      '看到截图了，你只',
      '先看参考项目里耗时的实现。',
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'text',
              text: '看到截图了，你只需要"总耗时 0:10"这部分，不要"最终消息"文案。先看参考项目的实现。',
            },
            {
              type: 'tool_use',
              id: 'search-1',
              name: 'search',
              input: { query: 'src' },
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({
      type: 'text',
      text: '看到截图了，你只需要"总耗时 0:10"这部分，不要"最终消息"文案。先看参考项目的实现。',
    });
    expect(content[1]).toMatchObject({
      type: 'tool_use',
      id: 'search-1',
      name: 'search',
    });
    expect(content[2]).toMatchObject({
      type: 'text',
      text: '先看参考项目里耗时的实现。',
    });
  });

  it('does not append a trailing duplicate text segment after a tool card appears', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = '我来对未提交的更改进行代码审查。';
    result.current.streamingTextSegmentsRef.current = [
      '我来对未提交的更改进行代码审查。',
      '来对未提交的更改进行代码审查。',
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'text',
              text: '我来对未提交的更改进行代码审查。',
            },
            {
              type: 'tool_use',
              id: 'bash-1',
              name: 'run_command',
              input: { command: 'git status --short' },
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: 'text',
      text: '我来对未提交的更改进行代码审查。',
    });
    expect(content[1]).toMatchObject({
      type: 'tool_use',
      id: 'bash-1',
      name: 'run_command',
    });
  });

  it('trims repeated prefixes from a delayed post-tool text segment and only keeps the novel tail', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current =
      '让我获取已更改文件的 diff。现在让我查看完整的文件内容以获取更多上下文。';
    result.current.streamingTextSegmentsRef.current = [
      '让我获取已更改文件的 diff。',
      '让我获取已更改文件的 diff。现在让我查看完整的文件内容以获取更多上下文。',
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'text',
              text: '让我获取已更改文件的 diff。',
            },
            {
              type: 'tool_use',
              id: 'batch-1',
              name: 'run_command',
              input: { command: 'git diff --stat' },
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({
      type: 'text',
      text: '让我获取已更改文件的 diff。',
    });
    expect(content[1]).toMatchObject({
      type: 'tool_use',
      id: 'batch-1',
      name: 'run_command',
    });
    expect(content[2]).toMatchObject({
      type: 'text',
      text: '现在让我查看完整的文件内容以获取更多上下文。',
    });
  });

  it('does not duplicate thinking blocks when incoming snapshot is cumulative', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = '分析完成，代码没有问题。';
    result.current.streamingTextSegmentsRef.current = ['分析完成，代码没有问题。'];
    result.current.streamingThinkingSegmentsRef.current = [
      'Let me analyze this code carefully.',
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'thinking',
              thinking: 'Let me analyze this code carefully.',
              text: 'Let me analyze this code carefully.',
            },
            {
              type: 'text',
              text: '分析完成，代码没有问题。',
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Let me analyze this code carefully.',
    });
    expect(content[1]).toMatchObject({
      type: 'text',
      text: '分析完成，代码没有问题。',
    });
  });

  it('keeps the more complete thinking block when streamed segment is partial', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = '结论如下。';
    result.current.streamingTextSegmentsRef.current = ['结论如下。'];
    result.current.streamingThinkingSegmentsRef.current = ['Let me analyze'];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'thinking',
              thinking: 'Let me analyze this code carefully.',
              text: 'Let me analyze this code carefully.',
            },
            {
              type: 'text',
              text: '结论如下。',
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Let me analyze this code carefully.',
    });
    expect(content[1]).toMatchObject({
      type: 'text',
      text: '结论如下。',
    });
  });

  it('handles empty thinking segment without overwriting existing thinking content', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = '完成。';
    result.current.streamingTextSegmentsRef.current = ['完成。'];
    result.current.streamingThinkingSegmentsRef.current = [''];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'thinking',
              thinking: 'Deep analysis of the problem.',
              text: 'Deep analysis of the problem.',
            },
            {
              type: 'text',
              text: '完成。',
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    const thinkingBlocks = content.filter((b) => b.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Deep analysis of the problem.',
    });
  });

  it('consolidates multiple backend thinking blocks into one to prevent duplication', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Response text.';
    result.current.streamingTextSegmentsRef.current = ['Response text.'];
    result.current.streamingThinkingSegmentsRef.current = [
      'Thinking part 1. Thinking part 2.',
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'thinking',
              thinking: 'Thinking part 1.',
              text: 'Thinking part 1.',
            },
            {
              type: 'thinking',
              thinking: 'Thinking part 1. Thinking part 2.',
              text: 'Thinking part 1. Thinking part 2.',
            },
            {
              type: 'text',
              text: 'Response text.',
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    const thinkingBlocks = content.filter((b) => b.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Thinking part 1. Thinking part 2.',
    });
    expect(content.filter((b) => b.type === 'text')).toHaveLength(1);
  });

  it('keeps separate thinking blocks when content is distinct', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Text 1. Text 2.';
    result.current.streamingTextSegmentsRef.current = ['Text 1.', 'Text 2.'];
    result.current.streamingThinkingSegmentsRef.current = [
      'Phase 1 thinking.',
      'Phase 2 thinking.',
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'thinking',
              thinking: 'Phase 1 thinking.',
              text: 'Phase 1 thinking.',
            },
            {
              type: 'text',
              text: 'Text 1.',
            },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'search',
              input: { query: 'test' },
            },
            {
              type: 'thinking',
              thinking: 'Phase 2 thinking.',
              text: 'Phase 2 thinking.',
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    // Smart merge preserves distinct thinking phases when content doesn't overlap
    const thinkingBlocks = content.filter((b) => b.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(2); // Two distinct phases, not merged
    expect(thinkingBlocks[0]).toMatchObject({ thinking: 'Phase 1 thinking.' });
    expect(thinkingBlocks[1]).toMatchObject({ thinking: 'Phase 2 thinking.' });
    // Verify positions: first thinking before text, second thinking after tool_use
    const thinking1Idx = content.findIndex((b) => b.type === 'thinking');
    const textIdx = content.findIndex((b) => b.type === 'text');
    const toolIdx = content.findIndex((b) => b.type === 'tool_use');
    const thinking2Idx = content.findIndex((b, i) => b.type === 'thinking' && i !== thinking1Idx);
    expect(thinking1Idx).toBeLessThan(textIdx);
    expect(toolIdx).toBeLessThan(thinking2Idx);
  });

  it('trims suffix-prefix overlap when markdown code block fence is duplicated', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current =
      "Here's code:\n```python\nprint('hello')\n```\n\nMore text";
    result.current.streamingTextSegmentsRef.current = [
      "Here's code:\n```python\nprint('hello')\n```",
      "\n\nMore text",
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: result.current.streamingContentRef.current,
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'text',
              text: "Here's code:\n```python\nprint('hello')\n```",
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    const textBlocks = content.filter((b) => b.type === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({
      type: 'text',
      text: "Here's code:\n```python\nprint('hello')\n```\n\nMore text",
    });
  });

  it('trims suffix-prefix overlap when code block body overlaps between blocks', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Scenario: Conservative sync pushed a backend snapshot, then subsequent
    // deltas arrived that partially duplicated the backend content due to
    // timing issues. The streamingTextSegments show the raw delta accumulation,
    // while the backend raw contains the synced portion.
    // This tests that trimDuplicateTextLikeContent correctly removes the overlap.
    result.current.streamingTextSegmentsRef.current = [
      "Here's code:\n```python\nprint('hello')\n```",
      "print('hello')\n```\n\nMore text", // Overlaps with tail of segment 0
    ];

    const assistant: ClaudeMessage = {
      type: 'assistant',
      // Backend snapshot content (the synced portion before overlap)
      content: "Here's code:\n```python\nprint('hello')\n```",
      isStreaming: true,
      raw: {
        message: {
          content: [
            {
              type: 'text',
              text: "Here's code:\n```python\nprint('hello')\n```",
            },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const content = ((patched.raw as any).message?.content ?? []) as Array<Record<string, unknown>>;

    const textBlocks = content.filter((b) => b.type === 'text');
    expect(textBlocks).toHaveLength(1);
    const merged = textBlocks[0].text as string;
    // Should not have duplicated "print('hello')\n```"
    expect(merged).not.toMatch(/print\('hello'\)\n```\n.*print\('hello'\)\n```/);
    // After trimming overlap, the novel content "\n\nMore text" is appended
    expect(merged).toBe("Here's code:\n```python\nprint('hello')\n```\n\nMore text");
  });
});
