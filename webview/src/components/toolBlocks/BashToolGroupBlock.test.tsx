import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BashToolGroupBlock from './BashToolGroupBlock';
import {
  BASH_GROUP_COLLAPSED_KEY,
  bashGroupCollapsePreference,
} from '../../utils/bashGroupCollapsePreference';
import { copyToClipboard } from '../../utils/copyUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/copyUtils', () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

const done = (content: string, isError = false) => ({ type: 'tool_result' as const, content, is_error: isError });

describe('BashToolGroupBlock', () => {
  beforeEach(() => {
    localStorage.removeItem(BASH_GROUP_COLLAPSED_KEY);
    vi.mocked(copyToClipboard).mockClear();
  });

  it('starts collapsed when configured and preserves manual expansion during updates', () => {
    bashGroupCollapsePreference.set(true);
    const { container, rerender } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { command: 'npm test' } }]} />,
    );
    expect(container.querySelector('.bash-group-list')).toBeNull();
    expect(container.querySelector('.bash-group-header')?.textContent).toContain('tools.bashGroupBatchRun');
    expect(container.querySelector('.bash-group-count')?.textContent).toBe('1');
    expect(container.querySelector('.bash-group-progress')?.textContent).toContain('0/1');

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);
    expect(container.querySelector('.bash-group-list')).toBeTruthy();

    rerender(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' }, result: done('passed') },
        { toolId: 'bash-2', input: { command: 'npm run build' } },
      ]} />,
    );
    expect(container.querySelectorAll('.bash-group-item')).toHaveLength(2);
    expect(container.querySelector('.bash-group-progress')?.textContent).toContain('1/2');

    act(() => bashGroupCollapsePreference.set(false));
    act(() => bashGroupCollapsePreference.set(true));
    expect(container.querySelector('.bash-group-list')).toBeTruthy();

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);
    expect(container.querySelector('.bash-group-list')).toBeNull();
  });

  it('applies preference changes live until the group is manually toggled', () => {
    const { container } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { command: 'npm test' } }]} />,
    );
    expect(container.querySelector('.bash-group-list')).toBeTruthy();

    act(() => bashGroupCollapsePreference.set(true));
    expect(container.querySelector('.bash-group-list')).toBeNull();

    act(() => bashGroupCollapsePreference.set(false));
    expect(container.querySelector('.bash-group-list')).toBeTruthy();

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);
    act(() => bashGroupCollapsePreference.set(true));
    act(() => bashGroupCollapsePreference.set(false));
    expect(container.querySelector('.bash-group-list')).toBeNull();
  });

  it('filters empty placeholders from batch counts and rows', () => {
    const { container } = render(
      <BashToolGroupBlock
        items={[
          { toolId: 'empty-object', input: {} },
          { toolId: 'empty-strings', input: { command: '  ', description: '\n' } },
          { toolId: 'real-command', input: { command: 'npm test' } },
        ]}
      />,
    );

    expect(container.querySelector('.bash-group-count')?.textContent).toBe('1');
    expect(container.querySelectorAll('.bash-group-item')).toHaveLength(1);
    expect(container.querySelector('.bash-group-row-command-text')?.textContent).toBe('npm test');
  });

  it.each(['Enter', ' '])('allows keyboard expansion and collapse with %j', (key) => {
    bashGroupCollapsePreference.set(true);
    const { container } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' } },
        { toolId: 'bash-2', input: { command: 'npm run build' } },
      ]} />,
    );
    const header = container.querySelector('.bash-group-header') as HTMLElement;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.tabIndex).toBe(0);
    expect(fireEvent.keyDown(header, { key })).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.bash-group-item')).toHaveLength(2);
    expect(fireEvent.keyDown(header, { key })).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.bash-group-list')).toBeNull();

    act(() => bashGroupCollapsePreference.set(false));
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the batch header expandable without rendering a chevron icon', () => {
    const { container } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { command: 'npm test', description: 'Run tests' } }]} />,
    );

    expect(container.querySelector('.bash-group-chevron')).toBeNull();
    expect(container.querySelector('.bash-group-list')).toBeTruthy();

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);

    expect(container.querySelector('.bash-group-list')).toBeNull();
  });

  it('shows a command peek in the header only while collapsed', () => {
    bashGroupCollapsePreference.set(true);
    const { container } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'git status --short' } },
        { toolId: 'bash-2', input: { command: 'npm run lint -- --fix' } },
      ]} />,
    );

    expect(container.querySelector('.bash-group-peek')?.textContent).toBe('git status · npm run');

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);
    expect(container.querySelector('.bash-group-peek')).toBeNull();
  });

  it('summarizes the batch with a status dot, a progress count, or a failure count', () => {
    const { container, rerender } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' }, result: done('ok') },
        { toolId: 'bash-2', input: { command: 'npm run build' }, result: done('ok') },
      ]} />,
    );
    const progress = () => container.querySelector('.bash-group-progress') as HTMLElement;
    expect(progress().classList.contains('completed')).toBe(true);
    expect(progress().querySelector('.tool-status-indicator.completed')).toBeTruthy();
    expect(progress().getAttribute('aria-label')).toBe('tools.bashGroupAllCompleted');

    rerender(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' }, result: done('boom', true) },
        { toolId: 'bash-2', input: { command: 'npm run build' } },
      ]} />,
    );
    expect(progress().classList.contains('error')).toBe(true);
    expect(progress().querySelector('.tool-status-indicator.error')).toBeTruthy();
    expect(progress().textContent).toContain('1 tools.bashGroupFailed');
  });

  it('marks each row with its own status icon', () => {
    const { container } = render(
      <BashToolGroupBlock
        deniedToolIds={new Set(['bash-3'])}
        items={[
          { toolId: 'bash-1', input: { command: 'npm test' }, result: done('ok') },
          { toolId: 'bash-2', input: { command: 'npm run build' } },
          { toolId: 'bash-3', input: { command: 'rm -rf dist' } },
        ]}
      />,
    );
    const states = Array.from(container.querySelectorAll('.bash-group-row-status'))
      .map(el => ['completed', 'pending', 'error'].find(name => el.classList.contains(name)));
    expect(states).toEqual(['completed', 'pending', 'error']);
    expect(container.querySelectorAll('.bash-group-item.error')).toHaveLength(1);
  });

  it('puts an explicit description beside the command and falls back to the bare command', () => {
    const { container } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'git status', description: 'Check pending changes' } },
        { toolId: 'bash-2', input: { command: 'npm test' } },
      ]} />,
    );
    const rows = container.querySelectorAll('.bash-group-row');
    expect(rows[0].querySelector('.bash-group-row-desc')?.textContent).toBe('Check pending changes');
    expect(rows[0].querySelector('.bash-group-row-command-text')?.textContent).toBe('git status');
    expect(rows[1].querySelector('.bash-group-row-desc')).toBeNull();
    expect(rows[1].querySelector('.bash-group-row-command')?.classList.contains('solo')).toBe(true);
    expect(rows[1].querySelector('.bash-group-row-command-text')?.textContent).toBe('npm test');
  });

  it('renders command and stdout text in dedicated output nodes', () => {
    const { container } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' }, result: done('stdout line 1\nstdout line 2') },
      ]} />,
    );

    fireEvent.click(container.querySelector('.bash-group-row-toggle') as HTMLElement);

    expect(container.querySelector('.bash-group-detail-command-text')?.textContent).toBe('npm test');
    expect(container.querySelector('.bash-group-detail-output')?.textContent).toBe('stdout line 1\nstdout line 2');
    expect(container.querySelector('.bash-group-detail-label')?.textContent).toBe('tools.bashGroupOutput');
  });

  it('labels failed and still-running details and shows the approval reason', () => {
    const { container } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'git push', justification: 'Needs network' }, result: done('rejected', true) },
        { toolId: 'bash-2', input: { command: 'npm run build' } },
      ]} />,
    );
    const rows = container.querySelectorAll('.bash-group-row-toggle');

    fireEvent.click(rows[0]);
    expect(container.querySelector('.bash-group-detail')?.classList.contains('error')).toBe(true);
    expect(container.querySelector('.bash-group-detail-label')?.textContent).toBe('tools.bashGroupOutputFailed');
    expect(container.querySelector('.bash-group-detail-reason')?.textContent).toContain('Needs network');

    fireEvent.click(rows[1]);
    expect(container.querySelectorAll('.bash-group-detail')).toHaveLength(1);
    expect(container.querySelector('.bash-group-detail-label')?.textContent).toBe('tools.bashGroupRunning');
    expect(container.querySelector('.bash-group-detail-output')).toBeNull();
  });

  it('uses a native button for each row toggle and keeps Enter away from window shortcuts', () => {
    const windowKeys = vi.fn();
    window.addEventListener('keydown', windowKeys);
    const { container } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { command: 'npm test' }, result: done('ok') }]} />,
    );
    const toggle = container.querySelector('.bash-group-row-toggle') as HTMLElement;

    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.querySelector('button')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.bash-group-detail')).toBeTruthy();

    fireEvent.keyDown(toggle, { key: 'Enter' });
    fireEvent.keyDown(toggle, { key: 'ArrowDown' });
    fireEvent.keyDown(container.querySelector('.bash-group-header') as HTMLElement, { key: 'Enter' });
    expect(windowKeys.mock.calls.map(([event]) => event.key)).toEqual(['ArrowDown']);
    window.removeEventListener('keydown', windowKeys);
  });

  it('keeps failures and the running count side by side', () => {
    const { container } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' }, result: done('boom', true) },
        { toolId: 'bash-2', input: { command: 'npm run build' } },
      ]} />,
    );
    const progress = Array.from(container.querySelectorAll('.bash-group-progress'));
    expect(progress.map(el => el.textContent)).toEqual(['1 tools.bashGroupFailed', '1/2']);
    expect(progress[1].querySelector('.tool-status-indicator.pending')).toBeTruthy();
  });

  it('does not dress a description-only entry up as a shell command', () => {
    const { container } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { description: 'Preparing command' } }]} />,
    );
    expect(container.querySelector('.bash-group-row-desc')?.textContent).toBe('Preparing command');
    expect(container.querySelector('.bash-group-copy')).toBeNull();

    fireEvent.click(container.querySelector('.bash-group-row-toggle') as HTMLElement);
    expect(container.querySelector('.bash-group-detail-command')).toBeNull();
  });

  it('copies the raw command from the row without toggling its detail', async () => {
    const { container } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: "bash -lc 'npm test'" }, result: done('ok') },
      ]} />,
    );
    const copy = container.querySelector('.bash-group-row .bash-group-copy') as HTMLElement;

    await act(async () => { fireEvent.click(copy); });

    expect(copyToClipboard).toHaveBeenCalledWith("bash -lc 'npm test'");
    expect(container.querySelector('.bash-group-detail')).toBeNull();
    expect(copy.classList.contains('copied')).toBe(true);
  });

  it('copies the output from the detail bar', async () => {
    const { container } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { command: 'npm test' }, result: done('all green') }]} />,
    );
    fireEvent.click(container.querySelector('.bash-group-row-toggle') as HTMLElement);

    await act(async () => {
      fireEvent.click(container.querySelector('.bash-group-detail .bash-group-copy') as HTMLElement);
    });

    expect(copyToClipboard).toHaveBeenCalledWith('all green');
  });
});
