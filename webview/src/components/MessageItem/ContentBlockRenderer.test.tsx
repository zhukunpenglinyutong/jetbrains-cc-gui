import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeContentBlock } from '../../types';
import { ContentBlockRenderer } from './ContentBlockRenderer';

vi.mock('../MarkdownBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-block">{content}</div>,
}));

const t = ((key: string) => {
  const translations: Record<string, string> = {
    'chat.providerError.title': '本次响应已停止',
    'chat.providerError.details': '错误详情',
    'chat.providerError.provider': '服务',
    'chat.providerError.exitCode': '退出码',
  };
  return translations[key] ?? key;
}) as any;

function getProviderErrorDetailsText(): string | null | undefined {
  return document.querySelector('.provider-error-details pre')?.textContent;
}

function renderBlock(block: ClaudeContentBlock) {
  return render(
    <ContentBlockRenderer
      block={block}
      messageIndex={0}
      messageType="assistant"
      isStreaming={false}
      isThinkingExpanded={false}
      isThinking={false}
      isLastMessage={true}
      isLastBlock={true}
      t={t}
      onToggleThinking={() => undefined}
      findToolResult={() => null}
    />,
  );
}

describe('ContentBlockRenderer provider_error', () => {
  it('renders provider errors as an inline assistant message block', () => {
    renderBlock({
      type: 'provider_error',
      provider: 'codex',
      summary: '服务暂时不可用',
      details: 'Codex CLI 请求失败，原因：服务暂时不可用 (503)',
      exitCode: 1,
    });

    expect(screen.getByText('本次响应已停止')).toBeTruthy();
    expect(document.querySelector('.provider-error-summary')).toBeNull();
    expect(getProviderErrorDetailsText()).toBe('Codex CLI 请求失败，原因：服务暂时不可用 (503)');
    expect(document.querySelector('.provider-error-block')).toBeTruthy();
  });

  it('renders a non-repeated provider error summary outside details', () => {
    renderBlock({
      type: 'provider_error',
      provider: 'codex',
      summary: '网络请求失败',
      details: 'Codex CLI exited with code 1',
      exitCode: 1,
    });

    expect(screen.getByText('网络请求失败')).toBeTruthy();
    expect(getProviderErrorDetailsText()).toBe('Codex CLI exited with code 1');
  });

  it('keeps the provider error summary visible when no separate details exist', () => {
    renderBlock({
      type: 'provider_error',
      provider: 'codex',
      summary: 'Codex CLI 请求失败',
      exitCode: 1,
    });

    expect(document.querySelector('.provider-error-summary')?.textContent).toBe('Codex CLI 请求失败');
    expect(getProviderErrorDetailsText()).toBe('Codex CLI 请求失败');
  });

  it('keeps repeated provider error details out of the outer summary', () => {
    const repeatedReason = 'Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)';
    const details = `Codex CLI 请求失败，原因：${repeatedReason}\n\nDetails: ${repeatedReason}`;

    renderBlock({
      type: 'provider_error',
      provider: 'codex',
      summary: repeatedReason,
      details,
      exitCode: 1,
    });

    expect(document.querySelector('.provider-error-summary')).toBeNull();
    expect(getProviderErrorDetailsText()).toBe(details);
  });
});
