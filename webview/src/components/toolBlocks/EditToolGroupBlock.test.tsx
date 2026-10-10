import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EditToolBlock from './EditToolBlock';
import { openFile, refreshFile, showDiff } from '../../utils/bridge';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
