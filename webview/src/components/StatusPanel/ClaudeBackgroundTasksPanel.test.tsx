import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import english from '../../i18n/locales/en.json';
import { ClaudeBackgroundTasksPanel } from './ClaudeBackgroundTasksPanel';
import { formatElapsed, orderBackgroundTasks } from './ClaudeBackgroundTaskRow';
import { getClaudeBackgroundTasks, receiveClaudeBackgroundTasks, resetClaudeBackgroundTasks } from '../../utils/claudeBackgroundTasks';

const translations = i18next.createInstance();
beforeAll(() => translations.init({ lng: 'en', resources: { en: { translation: english } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translations.t.bind(translations) }) }));

const task = (index: number) => ({ task_id: `task-${index}`, task_type: 'local_workflow',
  description: `Review module ${index}`, run_id: `run-${index}` });
const snapshot = (tasks: unknown[], session_id = 'claude-session') => ({
  type: 'system', subtype: 'background_tasks_changed', session_id, tasks,
});

describe('Claude native background work', () => {
  beforeEach(resetClaudeBackgroundTasks);

  const openPill = (label: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));

  it('shows one legacy background task behind a pill with a Stop control between turns', () => {
    const onStop = vi.fn();
    receiveClaudeBackgroundTasks({ ...snapshot([{ task_id: 'toolu-dev', task_type: 'legacy_task',
      description: 'npm run dev' }]), source: 'legacy' }, 'claude-session');
    render(<ClaudeBackgroundTasksPanel provider="claude" sessionId="claude-session" foregroundActive={false} onStop={onStop} />);
    expect(screen.queryByText('npm run dev')).toBeNull();
    openPill('1 background task');
    expect(screen.getByRole('dialog', { name: 'Background tasks' })).toBeTruthy();
    expect(screen.getByText('npm run dev')).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop background tasks' }));
    expect(onStop).toHaveBeenCalledOnce();
    act(() => { receiveClaudeBackgroundTasks({ ...snapshot([]), source: 'legacy' }, 'claude-session'); });
    expect(screen.queryByText(/1 background task/)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a full multi-agent snapshot and an actionable Stop after the foreground answer', () => {
    const onStop = vi.fn();
    const view = render(<ClaudeBackgroundTasksPanel provider="claude" sessionId="claude-session" foregroundActive onStop={onStop} />);
    act(() => { receiveClaudeBackgroundTasks(snapshot(Array.from({ length: 80 }, (_, index) => task(index))), 'claude-session'); });
    openPill('80 background tasks');
    expect(screen.getByText('80 running')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop background tasks' })).toBeNull();
    expect(screen.getByText('Can stop after the answer')).toBeTruthy();
    view.rerender(<ClaudeBackgroundTasksPanel provider="claude" sessionId="claude-session" foregroundActive={false} onStop={onStop} />);
    expect(screen.getByText('Review module 79')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop background tasks' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(getClaudeBackgroundTasks().tasks).toHaveLength(80);
    // Clicking Stop is only a request, not proof that the workers stopped.
    act(() => { receiveClaudeBackgroundTasks(snapshot([]), 'claude-session'); });
    expect(screen.queryByRole('button', { name: 'Stop background tasks' })).toBeNull();
  });

  it('nests children under their parent and expands a row into its details', () => {
    receiveClaudeBackgroundTasks(snapshot([
      { task_id: 'agent-1', task_type: 'local_agent', description: 'Scan logs', parent_task_id: 'wf-1' },
      task(1),
      { task_id: 'wf-1', task_type: 'local_workflow', description: 'Refactor panel', run_id: 'run-wf' },
    ]), 'claude-session');
    render(<ClaudeBackgroundTasksPanel provider="claude" sessionId="claude-session" foregroundActive={false} onStop={vi.fn()} />);
    openPill('3 background tasks');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map(row => row.querySelector('.claude-bg-desc')?.textContent))
      .toEqual(['Review module 1', 'Refactor panel', 'Scan logs']);
    expect(rows[2].style.getPropertyValue('--claude-bg-depth')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: /Scan logs/ }));
    expect(screen.getByText('agent-1')).toBeTruthy();
    expect(screen.getByText('(local_agent)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refactor panel' }));
    expect(screen.getByText('run-wf')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps each task\'s first-seen time across snapshots of the same session', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    receiveClaudeBackgroundTasks(snapshot([task(1)]), 'claude-session');
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    receiveClaudeBackgroundTasks(snapshot([task(1), task(2)]), 'claude-session');
    expect(getClaudeBackgroundTasks().tasks.map(entry => entry.startedAt)).toEqual([1_000, 5_000]);
    vi.spyOn(Date, 'now').mockReturnValue(9_000);
    receiveClaudeBackgroundTasks(snapshot([task(1)], 'next-session'), null);
    expect(getClaudeBackgroundTasks().tasks[0].startedAt).toBe(9_000);
    vi.restoreAllMocks();
  });

  it('formats elapsed time and orders orphans and cycles as roots', () => {
    expect([0, 59_999, 61_000, 3_725_000].map(formatElapsed)).toEqual(['0s', '59s', '1m 01s', '1h 02m']);
    const base = { taskType: 'local_agent', description: '', startedAt: 0 };
    const ordered = orderBackgroundTasks([
      { ...base, taskId: 'a', parentTaskId: 'b' }, { ...base, taskId: 'b', parentTaskId: 'a' },
      { ...base, taskId: 'c', parentTaskId: 'gone' },
    ]);
    expect(ordered.map(({ task, depth }) => `${task.taskId}:${depth}`)).toEqual(['c:0', 'a:0', 'b:1']);
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
    expect(screen.getByText('1 background task')).toBeTruthy();
    view.rerender(<ClaudeBackgroundTasksPanel provider="codex" sessionId="claude-session" foregroundActive={false} onStop={vi.fn()} />);
    expect(screen.queryByText('1 background task')).toBeNull();
    view.rerender(<ClaudeBackgroundTasksPanel provider="claude" sessionId="another-session" foregroundActive={false} onStop={vi.fn()} />);
    expect(screen.queryByText('1 background task')).toBeNull();
    act(resetClaudeBackgroundTasks);
    expect(getClaudeBackgroundTasks().tasks).toHaveLength(0);
  });
});
