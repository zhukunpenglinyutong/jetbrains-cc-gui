import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubagentProcessDetails from './SubagentProcessDetails';
import type { SubagentHistoryResponse } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const history: SubagentHistoryResponse = {
  success: true,
  completed: true,
  messages: [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'first reasoning step' }],
      },
    },
  ],
};

afterEach(() => cleanup());

describe('SubagentProcessDetails', () => {
  it('renders the prompt section above the thought section', () => {
    const { container } = render(
      <SubagentProcessDetails prompt="investigate the bug" history={history} canLoad />,
    );
    const sections = Array.from(container.querySelectorAll('.subagent-process-section'));
    const promptIdx = sections.findIndex((s) => s.querySelector('.subagent-prompt-card'));
    const thoughtIdx = sections.findIndex((s) => s.textContent?.includes('first reasoning step'));
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(thoughtIdx).toBeGreaterThan(promptIdx);
  });

  it('omits the prompt section when no prompt is provided', () => {
    const { container } = render(<SubagentProcessDetails history={history} canLoad />);
    expect(container.querySelector('.subagent-prompt-card')).toBeNull();
  });

  it('shows history errors only for terminal error status', () => {
    const { container, rerender } = render(
      <SubagentProcessDetails
        history={{ success: false, provider: 'codex', status: 'running', error: 'Codex subagent activity not found yet' }}
        canLoad
      />,
    );

    expect(container.querySelector('.subagent-error')).toBeNull();

    rerender(
      <SubagentProcessDetails
        history={{ success: false, provider: 'codex', status: 'error', error: 'Subagent history failed' }}
        canLoad
      />,
    );

    expect(container.querySelector('.subagent-error')?.textContent).toBe('Subagent history failed');
  });

  it('keeps Claude lookup failures visible even with a running status', () => {
    const { container } = render(
      <SubagentProcessDetails
        history={{ success: false, provider: 'claude', status: 'running', error: 'Subagent log not found' }}
        canLoad
      />,
    );

    expect(container.querySelector('.subagent-error')?.textContent).toBe('Subagent log not found');
  });
});
