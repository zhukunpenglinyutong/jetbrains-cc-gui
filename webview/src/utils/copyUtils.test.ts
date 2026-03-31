// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { extractMarkdownContent, copyToClipboard } from './copyUtils';
import type { ClaudeMessage } from '../types';

describe('extractMarkdownContent', () => {
  it('copies merged assistant text while skipping tool_use blocks', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'tool phase\nfinal answer',
      raw: {
        message: {
          content: [
            { type: 'text', text: 'tool phase' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
            { type: 'text', text: 'final answer' },
          ],
        },
      } as any,
    };

    expect(extractMarkdownContent(message)).toBe('tool phase\n\nfinal answer');
  });

  it('optionally includes thinking blocks in copied markdown', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'final answer',
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: 'final answer' },
          ],
        },
      } as any,
    };

    expect(extractMarkdownContent(message, true)).toBe('<thinking>\nreasoning\n</thinking>\n\nfinal answer');
    expect(extractMarkdownContent(message, false)).toBe('final answer');
  });
});

describe('copyToClipboard', () => {
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
    document.execCommand = originalExecCommand;
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard when available', async () => {
    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when clipboard API fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    document.execCommand = vi.fn().mockReturnValue(true);

    await expect(copyToClipboard('fallback')).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });
});
