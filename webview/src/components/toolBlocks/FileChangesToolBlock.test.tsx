import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileChangesToolBlock from './FileChangesToolBlock';
import EditToolBlock from './EditToolBlock';
import { openFile, refreshFile, showDiff } from '../../utils/bridge';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useIsToolDenied', () => ({ useIsToolDenied: () => false }));
vi.mock('../../hooks/useResolvedFileLinkTooltip', () => ({ useResolvedFileLinkTooltip: () => ({}) }));
vi.mock('../../utils/bridge', () => ({ openFile: vi.fn(), refreshFile: vi.fn(), showDiff: vi.fn() }));

describe('file change cards', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
  it('shows all patch files, opens the move destination, and expands the supplied diff', () => {
    const { container } = render(<FileChangesToolBlock name="apply_patch" input={{ patch:
      '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old line\n+new line\n*** Delete File: gone.ts\n*** End Patch' }}
      result={{ type: 'tool_result', content: 'Success' }} />);
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(2);
    expect(container.querySelector('.file-list-item')?.getAttribute('title')).toBe('tools.patchKind.move: old.ts → new.ts');
    expect(container.querySelectorAll('.tool-status-indicator.completed')).toHaveLength(2);
    fireEvent.click(screen.getByText('new.ts', { selector: '.clickable-file' }));
    expect(openFile).toHaveBeenCalledWith('new.ts', undefined, undefined);
    fireEvent.click(container.querySelector('.file-list-item button')!);
    expect(screen.getByText('old line')).toBeTruthy();
    expect(screen.getByText('new line')).toBeTruthy();
    expect(screen.queryByText('PATCH')).toBeNull();
    expect(container.querySelector('.patch-change-kind')).toBeNull();
    expect(container.querySelector('.patch-diff-toggle')).toBeNull();
    expect(refreshFile).toHaveBeenCalledWith('new.ts');
    expect(showDiff).not.toHaveBeenCalled();
  });
  it('does not mark proposed or declined native patches as successful', () => {
    const input = { changes: [{ path: 'a.ts', kind: 'add', diff: '+content' }], status: 'inProgress' };
    const { container, rerender } = render(<FileChangesToolBlock name="file_change" input={input} />);
    expect(container.querySelector('.tool-status-indicator.pending')).toBeTruthy();
    rerender(<FileChangesToolBlock name="file_change" input={{ ...input, status: 'declined' }} />);
    expect(container.querySelector('.tool-status-indicator.error')).toBeTruthy();
    expect(container.querySelector('.tool-status-indicator.completed')).toBeNull();
  });
  it('keeps terminal native status when an opaque file change falls back to the generic card', () => {
    const { container, rerender } = render(<FileChangesToolBlock name="file_change" input={{ changes: [], status: 'completed' }} />);
    expect(container.querySelector('.tool-status-indicator.completed')).toBeTruthy();
    rerender(<FileChangesToolBlock name="file_change" input={{ changes: [], status: 'interrupted' }} />);
    expect(container.querySelector('.tool-status-indicator.error')).toBeTruthy();
    expect(container.querySelector('.tool-status-indicator.pending')).toBeNull();
  });
  it('shares the Claude edit header, controls and default expansion without inventing full file contents', () => {
    localStorage.setItem('diffExpandedByDefault', 'true');
    const { container } = render(<><EditToolBlock items={[{ name: 'Edit',
      input: { file_path: 'a.ts', old_string: 'old line', new_string: 'new line' },
      result: { type: 'tool_result', content: 'Success' } }]} />
      <FileChangesToolBlock name="apply_patch" input={{ patch:
        '*** Begin Patch\n*** Update File: a.ts\n@@\n-old line\n+new line\n*** End Patch' }}
        result={{ type: 'tool_result', content: 'Success' }} /></>);
    const cards = container.querySelectorAll('.edit-file-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.task-header')?.outerHTML).toEqual(cards[1].querySelector('.task-header')?.outerHTML);
    expect(cards[0].querySelector('.task-details')).toBeTruthy();
    expect(cards[1].querySelector('.task-details')).toBeTruthy();
    fireEvent.click(cards[1].querySelector('button')!);
    expect(showDiff).not.toHaveBeenCalled();
    fireEvent.click(cards[0].querySelector('button')!);
    expect(showDiff).toHaveBeenCalledWith('a.ts', 'old line', 'new line', 'tools.editPrefix');
  });
  it('keeps unknown wrapper outcomes neutral and never refreshes them as successful edits', () => {
    const { container } = render(<FileChangesToolBlock name="apply_patch" input={{ patch:
      '*** Begin Patch\n*** Add File: a.ts\n+content\n*** End Patch', status: 'unknown' }} />);
    expect(container.querySelector('.tool-status-indicator.unknown')?.getAttribute('title')).toBe('tools.resultUnknown');
    expect(container.querySelector('.tool-status-indicator.pending')).toBeNull();
    expect(container.querySelector('.tool-status-indicator.completed')).toBeNull();
    expect(refreshFile).not.toHaveBeenCalled();
  });
  it('folds a real patch failure into the shared edit details and supports keyboard expansion', () => {
    const error = 'apply_patch verification failed: Failed to find expected lines';
    const { container } = render(<FileChangesToolBlock name="apply_patch" input={{ patch:
      '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch' }}
        result={{ type: 'tool_result', content: error, is_error: true }} />);
    expect(screen.queryByText(error)).toBeNull();
    const header = screen.getByRole('button', { name: 'tools.editFileTitle: a.ts' });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(screen.getByText(error)).toBeTruthy();
    expect(container.querySelector('.tool-status-indicator.error')).toBeTruthy();
    expect(container.querySelector('.patch-error-output')).toBeNull();
    expect(refreshFile).not.toHaveBeenCalled();
  });
});
