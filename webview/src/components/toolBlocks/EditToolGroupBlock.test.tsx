import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import EditToolBlock from './EditToolBlock';
import EditToolGroupBlock from './EditToolGroupBlock';
import { openFile, refreshFile, showDiff } from '../../utils/bridge';
import {
  EDIT_GROUP_COLLAPSED_KEY,
  setEditGroupCollapsedByDefault,
} from '../../utils/editGroupCollapsePreference';
import {
  BASH_GROUP_COLLAPSED_KEY,
  setBashGroupCollapsedByDefault,
} from '../../utils/bashGroupCollapsePreference';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'tools.editGroupProgress') {
        return `${options?.completed}/${options?.total} finished`;
      }
      if (key === 'tools.editGroupFailed') {
        return `Failed: ${options?.count}`;
      }
      return key;
    },
  }),
}));
vi.mock('../../hooks/useIsToolDenied', () => ({ useIsToolDenied: () => false }));
vi.mock('../../hooks/useResolvedFileLinkTooltip', () => ({ useResolvedFileLinkTooltip: () => ({}) }));
vi.mock('../../utils/bridge', () => ({ openFile: vi.fn(), refreshFile: vi.fn(), showDiff: vi.fn() }));

const patch = '*** Begin Patch\n*** Add File: a.ts\n+new file\n*** Update File: b.ts\n*** Move to: moved.ts\n@@\n-old line\n+new line\n*** End Patch';
const success = { type: 'tool_result' as const, content: 'Success' };

describe('shared edit batches', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
  afterEach(cleanup);

  it('batches every patch file with Claude edits and previews supplied hunks', () => {
    const { container } = render(<EditToolBlock items={[
      { name: 'apply_patch', input: { patch }, result: success, toolId: 'patch' },
      { name: 'Edit', input: { file_path: 'c.ts', old_string: 'old c', new_string: 'new c' }, result: success },
    ]} />);
    expect(screen.getByText('tools.editBatchTitle')).toBeTruthy();
    expect(screen.getByText('(3)')).toBeTruthy();
    expect(screen.getByText('+3')).toBeTruthy();
    expect(screen.getByText('-2')).toBeTruthy();
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(3);
    fireEvent.click(screen.getByText('moved.ts', { selector: '.clickable-file' }));
    expect(openFile).toHaveBeenCalledWith('moved.ts', undefined, undefined);
    fireEvent.click(container.querySelectorAll('.file-list-item')[1].querySelector('button')!);
    expect(screen.getByText('old line')).toBeTruthy();
    expect(screen.getByText('new line')).toBeTruthy();
    expect(showDiff).not.toHaveBeenCalled();
    expect(refreshFile).toHaveBeenCalledWith('moved.ts');
  });

  it('shows a batch for a single native change containing multiple files', () => {
    const { container } = render(<EditToolBlock items={[{ name: 'file_change', input: { status: 'completed', changes: [
      { path: 'a.ts', kind: 'add', diff: '+native a' }, { path: 'b.ts', kind: 'delete', diff: '-native b' },
    ] } }]} />);
    expect(screen.getByText('tools.editBatchTitle')).toBeTruthy();
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(2);
    expect(container.querySelectorAll('.tool-status-indicator.completed')).toHaveLength(2);
  });

  it('preserves unknown and failed outcomes and the actual error in the batch', () => {
    const { container } = render(<EditToolBlock items={[
      { name: 'apply_patch', input: { patch, status: 'unknown' }, toolId: 'unknown' },
      { name: 'file_change', input: { changes: [{ path: 'failed.ts', kind: 'update', diff: '-old\n+new' }], status: 'declined' },
        result: { ...success, is_error: true, content: 'Permission declined' }, toolId: 'failed' },
    ]} />);
    expect(container.querySelectorAll('.tool-status-indicator.unknown')).toHaveLength(2);
    expect(container.querySelectorAll('.tool-status-indicator.error')).toHaveLength(1);
    expect(refreshFile).not.toHaveBeenCalled();
    fireEvent.click(container.querySelectorAll('.file-list-item')[2].querySelector('button')!);
    expect(screen.getByText('Permission declined')).toBeTruthy();
  });

  it('retains unrecognized patches next to valid batch files', () => {
    const { container } = render(<EditToolBlock items={[
      { name: 'apply_patch', input: { patch }, toolId: 'valid' },
      { name: 'file_change', input: { changes: [{ path: 'future.ts', kind: 'future' }], status: 'completed' }, toolId: 'opaque' },
    ]} />);
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(2);
    expect(screen.getByText('File Change')).toBeTruthy();
    expect(container.querySelectorAll('.tool-status-indicator.completed')).toHaveLength(1);
  });
});

const items: ComponentProps<typeof EditToolGroupBlock>['items'] = [
  { name: 'Edit', input: { file_path: '/project/one.ts', old_string: 'old', new_string: 'new' } },
  { name: 'Edit', input: { file_path: '/project/two.ts', old_string: 'old', new_string: 'new' } },
];

describe('EditToolGroupBlock collapse preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(EDIT_GROUP_COLLAPSED_KEY);
    localStorage.removeItem(BASH_GROUP_COLLAPSED_KEY);
  });
  afterEach(cleanup);

  it('keeps native patch previews available after expansion without reporting unknown outcomes as successful', () => {
    setEditGroupCollapsedByDefault(true);
    const { container, getByRole } = render(<EditToolGroupBlock items={[
      { name: 'apply_patch', input: { patch, status: 'unknown' }, result: success, toolId: 'patch' },
    ]} />);
    expect(container.querySelector('.file-list-container')).toBeNull();
    expect(getByRole('status').textContent).not.toContain('tools.editGroupAllCompleted');
    expect(refreshFile).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { expanded: false }));
    expect(container.querySelectorAll('.tool-status-indicator.unknown')).toHaveLength(2);
    fireEvent.click(container.querySelectorAll('.file-list-item')[1].querySelector('button')!);
    expect(screen.getByText('old line')).toBeTruthy();
    expect(screen.getByText('new line')).toBeTruthy();
    expect(showDiff).not.toHaveBeenCalled();
  });

  it('keeps the file list expanded by default regardless of the command preference', () => {
    setBashGroupCollapsedByDefault(true);
    const { container } = render(<EditToolGroupBlock items={items} />);
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(2);
    expect(container.querySelector('.task-header')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('starts collapsed while retaining the edit count and change totals', () => {
    setEditGroupCollapsedByDefault(true);
    const { container } = render(<EditToolGroupBlock items={items} />);
    expect(container.querySelector('.file-list-container')).toBeNull();
    const header = container.querySelector('.task-header');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.textContent).toContain('(2)');
    expect(header?.textContent).toContain('+2');
    expect(header?.textContent).toContain('-2');
  });

  it('keeps pending, failed, and successful result summaries visible while collapsed', () => {
    setEditGroupCollapsedByDefault(true);
    const { container, getByRole, rerender } = render(<EditToolGroupBlock items={items} />);
    expect(getByRole('status').textContent).toContain('0/2 finished');

    rerender(<EditToolGroupBlock items={[
      { ...items[0], result: { type: 'tool_result', content: 'failed', is_error: true } },
      items[1],
    ]} />);
    expect(getByRole('status').textContent).toContain('1/2 finished');
    expect(getByRole('status').textContent).toContain('Failed: 1');
    expect(container.querySelector('.edit-group-progress.error')).toBeTruthy();
    expect(container.querySelector('.file-list-container')).toBeNull();

    rerender(<EditToolGroupBlock items={items.map(item => ({
      ...item, result: { type: 'tool_result', content: 'failed', is_error: true },
    }))} />);
    expect(getByRole('status').textContent).toContain('2/2 finished');
    expect(getByRole('status').textContent).toContain('Failed: 2');
    expect(getByRole('status').textContent).not.toContain('tools.editGroupAllCompleted');

    rerender(<EditToolGroupBlock items={items.map(item => ({
      ...item, result: { type: 'tool_result', content: 'done' },
    }))} />);
    expect(getByRole('status').textContent).toContain('tools.editGroupAllCompleted');
    expect(container.querySelector('.edit-group-progress.error')).toBeNull();
    expect(container.querySelector('.file-list-container')).toBeNull();
  });

  it.each(['Enter', ' '])('allows keyboard expansion and collapse with %j', (key) => {
    setEditGroupCollapsedByDefault(true);
    const { container, getByRole } = render(<EditToolGroupBlock items={items} />);
    const header = getByRole('button', { expanded: false });
    expect(header.tabIndex).toBe(0);
    expect(fireEvent.keyDown(header, { key })).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(2);
    expect(fireEvent.keyDown(header, { key })).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.file-list-container')).toBeNull();

    act(() => setEditGroupCollapsedByDefault(false));
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('counts edit operations when several entries target the same file', () => {
    setEditGroupCollapsedByDefault(true);
    const repeatedEdits = [items[0], items[0], items[0]];
    const { container } = render(<EditToolGroupBlock items={repeatedEdits} />);
    expect(container.querySelector('.tool-title-summary')?.textContent).toBe('(3)');
  });

  it('applies live changes until the user manually toggles the group', () => {
    const { container } = render(<EditToolGroupBlock items={items} />);
    act(() => setEditGroupCollapsedByDefault(true));
    expect(container.querySelector('.file-list-container')).toBeNull();
    act(() => setEditGroupCollapsedByDefault(false));
    expect(container.querySelector('.file-list-container')).toBeTruthy();

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    act(() => setEditGroupCollapsedByDefault(true));
    act(() => setEditGroupCollapsedByDefault(false));
    expect(container.querySelector('.file-list-container')).toBeNull();
  });

  it('preserves manual expansion as edits stream in and complete', () => {
    setEditGroupCollapsedByDefault(true);
    const { container, rerender } = render(<EditToolGroupBlock items={items} />);
    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    rerender(<EditToolGroupBlock items={[
      { ...items[0], result: { type: 'tool_result', content: 'done' } },
      items[1],
      { name: 'Edit', input: { file_path: '/project/three.ts', new_string: 'new' } },
    ]} />);
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(3);
    expect(container.querySelector('.tool-status-indicator.completed')).toBeTruthy();
    act(() => setEditGroupCollapsedByDefault(false));
    act(() => setEditGroupCollapsedByDefault(true));
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(3);
  });

  it('still refreshes successful edits while the list is collapsed', () => {
    setEditGroupCollapsedByDefault(true);
    const completedItems: typeof items = [
      { ...items[0], result: { type: 'tool_result', content: 'done' } },
      { ...items[1], result: { type: 'tool_result', content: 'failed', is_error: true } },
    ];
    const { container } = render(<EditToolGroupBlock items={completedItems} />);
    expect(container.querySelector('.file-list-container')).toBeNull();
    expect(refreshFile).toHaveBeenCalledExactlyOnceWith('/project/one.ts');
    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    expect(refreshFile).toHaveBeenCalledTimes(1);
  });

  it('keeps file opening and diff actions available after expanding', () => {
    setEditGroupCollapsedByDefault(true);
    const { container, getAllByTitle } = render(<EditToolGroupBlock items={items} />);
    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    fireEvent.click(container.querySelector('.clickable-file') as HTMLElement);
    expect(openFile).toHaveBeenCalledWith('/project/one.ts', undefined, undefined);
    fireEvent.click(getAllByTitle('tools.showDiffInIdea')[0]);
    expect(showDiff).toHaveBeenCalledWith('/project/one.ts', 'old', 'new', 'tools.editPrefix');
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(2);
  });
});
