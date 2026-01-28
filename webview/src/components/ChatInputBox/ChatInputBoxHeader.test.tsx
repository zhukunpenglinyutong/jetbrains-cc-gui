import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInputBoxHeader } from './ChatInputBoxHeader.js';

vi.mock('./AttachmentList.js', () => {
  return {
    AttachmentList: ({ attachments }: { attachments: unknown[] }) => (
      <div data-testid="attachment-list" data-count={attachments.length} />
    ),
  };
});

vi.mock('./ContextBar.js', () => {
  return {
    ContextBar: ({ activeFile }: { activeFile?: string }) => (
      <div data-testid="context-bar" data-activefile={activeFile ?? ''} />
    ),
  };
});

describe('ChatInputBoxHeader', () => {
  it('shows SDK warning and triggers install action', () => {
    const onInstallSdk = vi.fn();

    render(
      <ChatInputBoxHeader
        sdkInstalled={false}
        sdkStatusLoading={false}
        currentProvider="claude"
        onInstallSdk={onInstallSdk}
        t={((key: string) => key) as any}
        attachments={[]}
        onRemoveAttachment={vi.fn()}
        usagePercentage={0}
        showUsage={true}
        onAddAttachment={vi.fn()}
        onClearAgent={vi.fn()}
        hasMessages={false}
        statusPanelExpanded={false}
      />
    );

    expect(screen.getByText('chat.sdkNotInstalled')).toBeTruthy();
    fireEvent.click(screen.getByText('chat.goInstallSdk'));
    expect(onInstallSdk).toHaveBeenCalled();
  });

  it('renders attachments and passes through active file', () => {
    render(
      <ChatInputBoxHeader
        sdkInstalled={true}
        sdkStatusLoading={false}
        currentProvider="claude"
        t={((key: string) => key) as any}
        attachments={[{ id: '1' } as any]}
        onRemoveAttachment={vi.fn()}
        activeFile="src/a.ts"
        usagePercentage={0}
        showUsage={true}
        onAddAttachment={vi.fn()}
        onClearAgent={vi.fn()}
        hasMessages={false}
        statusPanelExpanded={false}
      />
    );

    expect(screen.getByTestId('attachment-list').getAttribute('data-count')).toBe('1');
    expect(screen.getByTestId('context-bar').getAttribute('data-activefile')).toBe('src/a.ts');
  });
});

