import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeContentBlock } from '../../types';
import { ContentBlockRenderer } from './ContentBlockRenderer';

// Capture the props MarkdownBlock receives without rendering the real marked
// pipeline. The block-level streaming flag is the value under test here.
const { markdownProps } = vi.hoisted(() => ({
  markdownProps: { isStreaming: undefined as boolean | undefined },
}));

vi.mock('../MarkdownBlock', () => ({
  default: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => {
    markdownProps.isStreaming = isStreaming;
    return <div data-testid="md">{content}</div>;
  },
}));

vi.mock('../CollapsibleTextBlock', () => ({ default: () => <div /> }));
vi.mock('../toolBlocks', () => ({
  BashToolBlock: () => null,
  EditToolBlock: () => null,
  GenericToolBlock: () => null,
  ReportFindingsToolBlock: ({ data }: { data: { findings: unknown[] } }) => (
    <div data-testid="report-findings-block">{data.findings.length}</div>
  ),
  parseReportFindingsInput: (input?: { findings?: unknown }) => (
    Array.isArray(input?.findings) ? { findings: input.findings } : null
  ),
  TaskExecutionBlock: () => null,
}));

const t = ((key: string) => key) as unknown as React.ComponentProps<
  typeof ContentBlockRenderer
>['t'];

const tableBlock = (): ClaudeContentBlock =>
  ({ type: 'text', text: '| a |\n|---|\n| 1 |' }) as unknown as ClaudeContentBlock;

function renderTextBlock({ isStreaming, isLastBlock }: { isStreaming: boolean; isLastBlock: boolean }) {
  markdownProps.isStreaming = undefined;
  return render(
    <ContentBlockRenderer
      block={tableBlock()}
      messageIndex={0}
      messageType="assistant"
      isStreaming={isStreaming}
      isThinkingExpanded={false}
      isThinking={false}
      isLastMessage={false}
      isLastBlock={isLastBlock}
      t={t}
      onToggleThinking={() => {}}
      findToolResult={() => null}
    />,
  );
}

function reportFindingsBlock(): ClaudeContentBlock {
  return {
    type: 'tool_use',
    name: 'ReportFindings',
    input: { findings: [{ summary: 'A structured finding' }] },
  } as ClaudeContentBlock;
}

describe('native thinking lifecycle', () => {
  const renderThinking = (block: ClaudeContentBlock, isStreaming = true) => render(
    <ContentBlockRenderer
      block={block}
      messageIndex={0}
      messageType="assistant"
      isStreaming={isStreaming}
      isThinkingExpanded
      isThinking
      isLastMessage
      isLastBlock
      t={t}
      onToggleThinking={() => {}}
      findToolResult={() => null}
    />,
  );

  it.each([
    { status: 'inProgress', isStreaming: true, thinking: '' },
    { status: 'inProgress', isStreaming: true, thinking: ' \n\t' },
    { status: 'completed', isStreaming: true },
    { status: 'inProgress', isStreaming: false },
    { status: undefined, isStreaming: false },
  ])('hides empty native thinking for $status with stream $isStreaming', ({ status, isStreaming, thinking }) => {
    const { container } = renderThinking({ type: 'thinking', thinking, native: true, status }, isStreaming);

    expect(container.querySelector('.thinking-block')).toBeNull();
    expect(screen.queryByTestId('md')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders supplied native plaintext instead of the empty-content hint', () => {
    renderThinking({ type: 'thinking', thinking: 'A visible native summary', native: true, status: 'completed' });

    expect(screen.getByTestId('md').textContent).toBe('A visible native summary');
    expect(markdownProps.isStreaming).toBe(false);
  });

  it('reveals a public summary when it arrives and retains it through completion', () => {
    const renderBlock = (thinking: string, status: string) => <ContentBlockRenderer
      block={{ type: 'thinking', thinking, native: true, status }} messageIndex={0} messageType="assistant"
      isStreaming isThinkingExpanded isThinking isLastMessage isLastBlock t={t}
      onToggleThinking={() => {}} findToolResult={() => null} />;
    const { rerender } = render(renderBlock('', 'inProgress'));
    expect(screen.queryByTestId('md')).toBeNull();

    rerender(renderBlock('A public native summary', 'inProgress'));
    expect(screen.getByTestId('md').textContent).toBe('A public native summary');
    expect(document.querySelector('.thinking-title')?.textContent).toBe('common.thinkingProcess');

    rerender(renderBlock('A public native summary', 'completed'));
    expect(screen.getByTestId('md').textContent).toBe('A public native summary');
    expect(document.querySelector('.thinking-title')?.textContent).toBe('common.thinking');
    expect(markdownProps.isStreaming).toBe(false);
  });

  it('renders a native plaintext text field without a thinking field', () => {
    renderThinking({ type: 'thinking', text: 'A supplied native text summary', native: true, status: 'completed' });
    expect(screen.getByTestId('md').textContent).toBe('A supplied native text summary');
  });

  it('keeps the ordinary Claude empty-string and streaming behavior', () => {
    renderThinking({ type: 'thinking', thinking: '' });

    expect(screen.getByTestId('md').textContent).toBe('');
    expect(document.querySelector('.thinking-title')?.textContent).toBe('common.thinkingProcess');
    expect(markdownProps.isStreaming).toBe(true);
  });
});

describe('ContentBlockRenderer block-level streaming', () => {
  it('routes a valid ReportFindings tool call to its structured renderer', () => {
    render(
      <ContentBlockRenderer
        block={reportFindingsBlock()}
        messageIndex={0}
        messageType="assistant"
        isStreaming={false}
        isThinkingExpanded={false}
        isThinking={false}
        isLastMessage={true}
        isLastBlock={true}
        t={t}
        onToggleThinking={() => {}}
        findToolResult={() => null}
      />,
    );

    expect(document.querySelector('[data-testid="report-findings-block"]')?.textContent).toBe('1');
    expect(document.querySelector('[data-testid="content-block-tool_use"]')).toBeNull();
  });

  it('keeps the last block streaming while the message is still streaming', () => {
    renderTextBlock({ isStreaming: true, isLastBlock: true });
    expect(markdownProps.isStreaming).toBe(true);
  });

  it('drops an earlier text block out of streaming once a later block arrives', () => {
    // A tool call (or any later block) arriving makes this text block non-last.
    // It must leave the lightweight streaming renderer for the full marked
    // pipeline, otherwise tables/lists stay hidden until the whole turn ends.
    renderTextBlock({ isStreaming: true, isLastBlock: false });
    expect(markdownProps.isStreaming).toBe(false);
  });

  it('renders with the full pipeline once the message has stopped streaming', () => {
    renderTextBlock({ isStreaming: false, isLastBlock: true });
    expect(markdownProps.isStreaming).toBe(false);
  });
});
