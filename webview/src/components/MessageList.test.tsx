import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { MessageList } from './MessageList';

// Mock MessageItem to keep this suite focused on list-level paging behaviour.
vi.mock('./MessageItem', () => ({
  MessageItem: ({ messageKey, message }: { messageKey: string; message: ClaudeMessage }) => (
    <div data-testid="message-item" data-key={messageKey} data-type={message.type}>
      {message.content}
    </div>
  ),
}));

vi.mock('./WaitingIndicator', () => ({
  default: () => <div data-testid="waiting-indicator">waiting</div>,
}));

vi.mock('./ContextMenu', () => ({
  ContextMenu: () => null,
}));

vi.mock('../hooks/useContextMenu.js', () => ({
  useContextMenu: () => ({
    visible: false,
    x: 0,
    y: 0,
    savedRange: null,
    selectedText: '',
    open: vi.fn(),
    close: vi.fn(),
  }),
  copySelection: vi.fn(),
}));

const t = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'chat.showEarlierMessages') {
    const count = opts?.count ?? 0;
    return `Show ${count} earlier`;
  }
  return key;
}) as never;

function makeMessages(count: number, idPrefix = 'm'): ClaudeMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    id: `${idPrefix}-${i}`,
  }) as unknown as ClaudeMessage);
}

const noopGetText = (m: ClaudeMessage) => m.content ?? '';
const noopGetBlocks = (_m: ClaudeMessage): ClaudeContentBlock[] => [];
const noopFindToolResult = (_id: string | undefined, _i: number): ToolResultBlock | null => null;
const noopExtractMd = (_m: ClaudeMessage) => '';

function renderList(messages: ClaudeMessage[]) {
  const endRef = createRef<HTMLDivElement>();
  return render(
    <MessageList
      messages={messages}
      streamingActive={false}
      isThinking={false}
      loading={false}
      loadingStartTime={null}
      t={t}
      getMessageText={noopGetText}
      getContentBlocks={noopGetBlocks}
      findToolResult={noopFindToolResult}
      extractMarkdownContent={noopExtractMd}
      messagesEndRef={endRef}
    />
  );
}

describe('MessageList paged collapse', () => {
  afterEach(cleanup);

  it('renders all messages when total ≤ visible window (15)', () => {
    renderList(makeMessages(10));
    expect(screen.getAllByTestId('message-item')).toHaveLength(10);
    expect(screen.queryByText(/Show.*earlier/)).toBeNull();
  });

  it('collapses earlier messages when total > visible window', () => {
    const { container } = renderList(makeMessages(50));
    // Visible: last 15 messages
    expect(screen.getAllByTestId('message-item')).toHaveLength(15);
    // Indicator shows next chunk size (30) and remaining total (35) appended
    const indicator = container.querySelector('.collapsed-messages-indicator');
    expect(indicator).toBeTruthy();
    expect(indicator?.textContent).toContain('Show 30 earlier');
    expect(indicator?.textContent).toContain('(35)');
  });

  it('reveals one chunk per click instead of expanding everything', () => {
    const { container } = renderList(makeMessages(100));
    expect(screen.getAllByTestId('message-item')).toHaveLength(15);

    const indicator = container.querySelector('.collapsed-messages-indicator');
    expect(indicator?.textContent).toContain('Show 30 earlier');
    fireEvent.click(indicator!);
    // 15 + 30 chunk
    expect(screen.getAllByTestId('message-item')).toHaveLength(45);

    fireEvent.click(container.querySelector('.collapsed-messages-indicator')!);
    expect(screen.getAllByTestId('message-item')).toHaveLength(75);
  });

  it('removes the indicator once everything is revealed', () => {
    const { container } = renderList(makeMessages(40));
    const indicator = container.querySelector('.collapsed-messages-indicator');
    // 40 - 15 = 25 collapsed → next click size = min(30, 25) = 25
    expect(indicator?.textContent).toContain('Show 25 earlier');
    // Total <= chunk → no extra " (N)" suffix
    expect(indicator?.textContent).not.toMatch(/\(\d+\)/);

    fireEvent.click(indicator!);
    expect(screen.getAllByTestId('message-item')).toHaveLength(40);
    expect(container.querySelector('.collapsed-messages-indicator')).toBeNull();
  });

  it('reports collapsedCount changes to parent for anchor rail sync', () => {
    const onCollapsedCountChange = vi.fn();
    const messages = makeMessages(60);
    const endRef = createRef<HTMLDivElement>();
    const { rerender, container } = render(
      <MessageList
        messages={messages}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
        onCollapsedCountChange={onCollapsedCountChange}
      />
    );

    // Initial: 60 - 15 = 45 collapsed
    expect(onCollapsedCountChange).toHaveBeenLastCalledWith(45);

    // Reveal one chunk
    const indicator = container.querySelector('.collapsed-messages-indicator');
    fireEvent.click(indicator!);
    expect(onCollapsedCountChange).toHaveBeenLastCalledWith(15);

    // Trigger a session switch via first-message-id change
    rerender(
      <MessageList
        messages={makeMessages(50, 'session2')}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
        onCollapsedCountChange={onCollapsedCountChange}
      />
    );
    // Reset → 50 - 15 = 35 collapsed
    expect(onCollapsedCountChange).toHaveBeenLastCalledWith(35);
  });
});

describe('MessageList container behaviour', () => {
  afterEach(cleanup);

  it('uses the latest message index for isLast even when paginated', () => {
    const messages = makeMessages(40);
    renderList(messages);
    const items = screen.getAllByTestId('message-item');
    const last = items[items.length - 1];
    // The last item must correspond to messages[39]
    expect(last.textContent).toBe('message 39');
  });

  it('renders waiting indicator when loading', () => {
    const endRef = createRef<HTMLDivElement>();
    render(
      <MessageList
        messages={makeMessages(3)}
        streamingActive={false}
        isThinking={false}
        loading={true}
        loadingStartTime={Date.now()}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
      />
    );
    expect(screen.getByTestId('waiting-indicator')).toBeTruthy();
  });
});
