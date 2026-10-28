import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBackgroundTasksPanel } from './ClaudeBackgroundTasksPanel';
import { getClaudeBackgroundTasks, receiveClaudeBackgroundTasks, resetClaudeBackgroundTasks } from '../../utils/claudeBackgroundTasks';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options: { count?: number }) =>
  key === 'chat.backgroundTasksRunning' ? `${options.count} background tasks running` : 'Stop background tasks' }) }));

const task = (index: number) => ({ task_id: `task-${index}`, task_type: 'local_workflow',
  description: `Review module ${index}`, run_id: `run-${index}` });
const snapshot = (tasks: unknown[], session_id = 'claude-session') => ({
  type: 'system', subtype: 'background_tasks_changed', session_id, tasks,
});

describe('Claude native background work', () => {
  beforeEach(resetClaudeBackgroundTasks);

  it('keeps a full multi-agent snapshot and an actionable Stop after the foreground answer', () => {
    const onStop = vi.fn();
    const view = render(<ClaudeBackgroundTasksPanel provider="claude" sessionId="claude-session" foregroundActive onStop={onStop} />);
    act(() => { receiveClaudeBackgroundTasks(snapshot(Array.from({ length: 80 }, (_, index) => task(index))), 'claude-session'); });
    expect(screen.getByText('80 background tasks running')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop background tasks' })).toBeNull();
    view.rerender(<ClaudeBackgroundTasksPanel provider="claude" sessionId="claude-session" foregroundActive={false} onStop={onStop} />);
    expect(screen.getByText('Review module 79')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop background tasks' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(getClaudeBackgroundTasks().tasks).toHaveLength(80);
    // Clicking Stop is only a request, not proof that the workers stopped.
    act(() => { receiveClaudeBackgroundTasks(snapshot([]), 'claude-session'); });
    expect(screen.queryByRole('button', { name: 'Stop background tasks' })).toBeNull();
  });

  it('uses replacement snapshots, ignores ambient tasks and never guesses from terminal edges', () => {
    receiveClaudeBackgroundTasks(snapshot([task(1), task(2), { ...task(3), ambient: true }]), 'claude-session');
    expect(getClaudeBackgroundTasks().tasks).toHaveLength(2);
    receiveClaudeBackgroundTasks({ subtype: 'task_notification', task_id: 'task-1', status: 'completed' }, 'claude-session');
    expect(getClaudeBackgroundTasks().tasks).toHaveLength(2);
    receiveClaudeBackgroundTasks(snapshot([task(2)]), 'claude-session');
    expect(getClaudeBackgroundTasks().tasks.map(entry => entry.taskId)).toEqual(['task-2']);
    receiveClaudeBackgroundTasks(snapshot([{ ...task(3), ambient: true }]), 'claude-session');
    expect(getClaudeBackgroundTasks().tasks).toHaveLength(0);
  });

  it('cannot clear live work with malformed or another session\'s snapshots', () => {
    receiveClaudeBackgroundTasks(snapshot([task(1)]), 'claude-session');
    for (const invalid of [snapshot([], 'other-session'), snapshot([{}]), snapshot([null]),
      { subtype: 'background_tasks_changed', tasks: [] }, { ...snapshot([]), tasks: null }]) {
      expect(receiveClaudeBackgroundTasks(invalid, 'claude-session')).toBe(false);
      expect(getClaudeBackgroundTasks().tasks).toHaveLength(1);
    }
  });

  it('hides another session/provider, retains the first bound identity and clears on reset', () => {
    receiveClaudeBackgroundTasks(snapshot([task(1)]), null);
    const view = render(<ClaudeBackgroundTasksPanel provider="claude" sessionId="claude-session" foregroundActive={false} onStop={vi.fn()} />);
    expect(screen.getByText('1 background tasks running')).toBeTruthy();
    view.rerender(<ClaudeBackgroundTasksPanel provider="codex" sessionId="claude-session" foregroundActive={false} onStop={vi.fn()} />);
    expect(screen.queryByText('1 background tasks running')).toBeNull();
    view.rerender(<ClaudeBackgroundTasksPanel provider="claude" sessionId="another-session" foregroundActive={false} onStop={vi.fn()} />);
    expect(screen.queryByText('1 background tasks running')).toBeNull();
    act(resetClaudeBackgroundTasks);
    expect(getClaudeBackgroundTasks().tasks).toHaveLength(0);
  });
});
