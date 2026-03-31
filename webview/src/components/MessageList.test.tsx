// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';
import type { ClaudeMessage, ToolResultBlock } from '../types';

const messageItemSpy = vi.fn();

vi.mock('./MessageItem', () => ({
  MessageItem: ({ message, toolResultSignature }: { message: ClaudeMessage; toolResultSignature?: string }) => {
    messageItemSpy(message, toolResultSignature);
    return <div>{message.content}</div>;
  },
}));

vi.mock('./WaitingIndicator', () => ({
  default: () => <div>waiting</div>,
}));

vi.mock('./ContextMenu', () => ({
  ContextMenu: () => null,
}));

vi.mock('../hooks/useContextMenu.js', () => ({
  useContextMenu: () => ({
    visible: false,
    x: 0,
    y: 0,
    close: vi.fn(),
    open: vi.fn(),
    savedRange: null,
    selectedText: '',
  }),
  copySelection: vi.fn(),
}));

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === 'chat.showEarlierMessages') return `show ${String(options?.count)}`;
  return key;
}) as any;

const makeMessage = (index: number, prefix: string, sessionSeed = 'a'): ClaudeMessage => ({
  type: index % 2 === 0 ? 'user' : 'assistant',
  content: `${prefix}-${index}`,
  timestamp: `2026-03-31T00:${sessionSeed}:${String(index).padStart(2, '0')}Z`,
});

describe('MessageList', () => {
  it('resets collapsed state when the first rendered message identity changes', () => {
    const initialMessages = Array.from({ length: 18 }, (_, i) => makeMessage(i, 'session-a', '00'));
    const nextMessages = Array.from({ length: 18 }, (_, i) => makeMessage(i, 'session-b', '01'));

    const { rerender } = render(
      <MessageList
        messages={initialMessages}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={(message) => message.content || ''}
        getContentBlocks={() => []}
        findToolResult={() => null}
        extractMarkdownContent={() => ''}
        messagesEndRef={{ current: null }}
      />,
    );

    fireEvent.click(screen.getByText('show 3'));
    expect(screen.queryByText('show 3')).toBeNull();
    expect(screen.getByText('session-a-0')).toBeTruthy();

    rerender(
      <MessageList
        messages={nextMessages}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={(message) => message.content || ''}
        getContentBlocks={() => []}
        findToolResult={() => null}
        extractMarkdownContent={() => ''}
        messagesEndRef={{ current: null }}
      />,
    );

    expect(screen.getByText('show 3')).toBeTruthy();
    expect(screen.queryByText('session-b-0')).toBeNull();
  });

  it('computes tool result signature using the rendered message as anchor', () => {
    messageItemSpy.mockClear();
    const assistantMessage: ClaudeMessage = {
      type: 'assistant',
      content: 'tool call',
      __turnId: 7,
      raw: {
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
        },
      } as any,
    };

    const findToolResult = vi.fn<(...args: [string | undefined, number, ClaudeMessage?]) => ToolResultBlock | null>(() => ({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'done',
    }));

    render(
      <MessageList
        messages={[assistantMessage]}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={(message) => message.content || ''}
        getContentBlocks={() => [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }]}
        findToolResult={findToolResult}
        extractMarkdownContent={() => ''}
        messagesEndRef={{ current: null }}
      />,
    );

    expect(findToolResult).toHaveBeenCalledWith('tool-1', 0, assistantMessage);
    expect(messageItemSpy).toHaveBeenCalledWith(
      assistantMessage,
      'tool-1:ok:4:done',
    );
  });
});
