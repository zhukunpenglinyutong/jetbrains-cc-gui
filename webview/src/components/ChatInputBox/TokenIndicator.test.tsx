import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenIndicator } from './TokenIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      if (key === 'chat.context') return '上下文';
      if (key === 'chat.usagePercentage') return `上下文: ${options?.percentage}`;
      if (key === 'chat.tokenIndicator.contextStats') return '上下文统计';
      if (key === 'chat.tokenIndicator.inputToken') return '输入 Token';
      if (key === 'chat.tokenIndicator.outputToken') return '输出 Token';
      if (key === 'chat.tokenIndicator.cacheRead') return '缓存读取';
      if (key === 'chat.tokenIndicator.cacheWrite') return '缓存写入';
      if (key === 'chat.tokenIndicator.cacheHitRate') return `${options?.rate}% 命中`;
      if (key === 'chat.tokenIndicator.total') return `总计 ${options?.used} / ${options?.max}`;
      return key;
    },
  }),
}));

describe('TokenIndicator', () => {
  it('renders the context usage chip as the hover entry and groups detailed usage data', () => {
    render(
      <TokenIndicator
        percentage={23.4}
        usedTokens={2340}
        maxTokens={10000}
        tokenDetail={{
          inputTokens: 1200,
          outputTokens: 340,
          cacheCreationTokens: 80,
          cacheReadTokens: 600,
          totalTokens: 2220,
          maxTokens: 10000,
          percentage: 22.2,
          cacheHitRate: 31.9,
        }}
      />,
    );

    expect(screen.getByRole('meter', { name: /上下文统计 23%/ })).toBeTruthy();
    expect(screen.getByText('上下文统计')).toBeTruthy();
    expect(screen.getByText('输入 Token')).toBeTruthy();
    expect(screen.getByText('输出 Token')).toBeTruthy();
    expect(screen.getByText('缓存读取')).toBeTruthy();
    expect(screen.getByText('缓存写入')).toBeTruthy();
    expect(screen.getByText('600')).toBeTruthy();
    expect(screen.getByText('31.9% 命中')).toBeTruthy();
    expect(screen.getByText(/总计\s*2,220\s*\/\s*10,000/)).toBeTruthy();
  });
});
