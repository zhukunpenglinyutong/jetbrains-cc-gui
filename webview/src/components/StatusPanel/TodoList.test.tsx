import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TodoList from './TodoList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('TodoList', () => {
  it('only animates an in-progress item while the conversation is streaming', () => {
    const todo = [{ content: 'Implement', status: 'in_progress' as const }];
    const { container, rerender } = render(<TodoList todos={todo} isStreaming={false} />);

    expect(container.querySelector('.status-panel-todo-icon')?.classList.contains('is-streaming')).toBe(false);

    rerender(<TodoList todos={todo} isStreaming />);
    expect(container.querySelector('.status-panel-todo-icon')?.classList.contains('is-streaming')).toBe(true);
  });
});
