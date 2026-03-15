import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageUsage } from './MessageUsage';
import type { ClaudeRawMessage } from '../../types';

function makeRaw(usage: Record<string, number>): ClaudeRawMessage {
  return { message: { usage } } as unknown as ClaudeRawMessage;
}

describe('MessageUsage', () => {
  it('renders nothing when raw is undefined', () => {
    const { container } = render(<MessageUsage />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when raw is a string', () => {
    const { container } = render(<MessageUsage raw="some string" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no usage data', () => {
    const { container } = render(<MessageUsage raw={{ message: {} }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when tokens are zero', () => {
    const { container } = render(
      <MessageUsage raw={makeRaw({ input_tokens: 0, output_tokens: 0 })} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders basic token counts', () => {
    render(
      <MessageUsage raw={makeRaw({ input_tokens: 500, output_tokens: 200 })} />
    );
    expect(screen.getByText(/500 in/)).toBeDefined();
    expect(screen.getByText(/200 out/)).toBeDefined();
  });

  it('formats thousands with k suffix', () => {
    render(
      <MessageUsage raw={makeRaw({ input_tokens: 1200, output_tokens: 800 })} />
    );
    expect(screen.getByText(/1\.2k in/)).toBeDefined();
    expect(screen.getByText(/800 out/)).toBeDefined();
  });

  it('drops trailing .0 on k format', () => {
    render(
      <MessageUsage raw={makeRaw({ input_tokens: 2000, output_tokens: 3000 })} />
    );
    expect(screen.getByText(/2k in/)).toBeDefined();
    expect(screen.getByText(/3k out/)).toBeDefined();
  });

  it('shows cache totals when present', () => {
    render(
      <MessageUsage raw={makeRaw({
        input_tokens: 1500,
        output_tokens: 400,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      })} />
    );
    expect(screen.getByText(/1\.5k in/)).toBeDefined();
    expect(screen.getByText(/1k cached/)).toBeDefined();
    expect(screen.getByText(/400 out/)).toBeDefined();
  });

  it('omits cache when cache tokens are zero', () => {
    render(
      <MessageUsage raw={makeRaw({
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      })} />
    );
    const text = screen.getByText(/500 in/).textContent ?? '';
    expect(text).not.toContain('cached');
  });

  it('has the correct CSS class', () => {
    const { container } = render(
      <MessageUsage raw={makeRaw({ input_tokens: 100, output_tokens: 50 })} />
    );
    expect(container.querySelector('.message-usage')).toBeDefined();
  });
});
