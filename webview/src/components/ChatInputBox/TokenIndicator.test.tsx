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
      if (key === 'chat.tokenIndicator.sessionInfo') return `当前会话 · ${options?.model} · ${options?.maxTokens} 上下文窗口`;
      if (key === 'chat.tokenIndicator.includes') return '包含：系统提示词、消息、文件上下文、工具结果、缓存读取';
      if (key === 'chat.tokenIndicator.source') return '来源：系统提示词 · 历史消息 · 当前文件 · 工具输入/输出';
      return key;
    },
  }),
}));

describe('TokenIndicator', () => {
  it('renders the chip with percentage and detailed tooltip grid', () => {
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
        modelName="Claude Sonnet 4.6"
      />,
    );

    expect(screen.getByRole('meter', { name: /上下文统计 23%/ })).toBeTruthy();
    expect(screen.getByText('上下文统计')).toBeTruthy();
    expect(screen.getByText('输入 Token')).toBeTruthy();
    expect(screen.getByText('输出 Token')).toBeTruthy();
    expect(screen.getByText('缓存读取')).toBeTruthy();
    expect(screen.getByText('缓存写入')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText('340')).toBeTruthy();
    expect(screen.getByText('600')).toBeTruthy();
    expect(screen.getByText('31.9% 命中')).toBeTruthy();
    expect(screen.getByText(/总计\s*2,220\s*\/\s*10,000/)).toBeTruthy();
    // New header content
    expect(screen.getByText(/当前会话 · Claude Sonnet 4.6/)).toBeTruthy();
    expect(screen.getByText('包含：系统提示词、消息、文件上下文、工具结果、缓存读取')).toBeTruthy();
    expect(screen.getByText('来源：系统提示词 · 历史消息 · 当前文件 · 工具输入/输出')).toBeTruthy();
  });

  it('applies level-ok class when percentage < 50', () => {
    const { container } = render(<TokenIndicator percentage={35} />);
    const indicator = container.querySelector('.ring-indicator');
    expect(indicator?.classList.contains('level-ok')).toBe(true);
    expect(indicator?.classList.contains('level-warn')).toBe(false);
    expect(indicator?.classList.contains('level-high')).toBe(false);
  });

  it('applies level-warn class when percentage is 50-79', () => {
    const { container } = render(<TokenIndicator percentage={65} />);
    const indicator = container.querySelector('.ring-indicator');
    expect(indicator?.classList.contains('level-warn')).toBe(true);
  });

  it('applies level-high class when percentage >= 80', () => {
    const { container } = render(<TokenIndicator percentage={90} />);
    const indicator = container.querySelector('.ring-indicator');
    expect(indicator?.classList.contains('level-high')).toBe(true);
  });

  it('displays rounded integer percentage in the ring center', () => {
    const { container } = render(<TokenIndicator percentage={23.4} />);
    const pct = container.querySelector('.ring-pct');
    expect(pct?.textContent).toBe('23%');
  });
});
