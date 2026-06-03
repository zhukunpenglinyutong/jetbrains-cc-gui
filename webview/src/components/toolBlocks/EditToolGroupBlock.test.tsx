import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EditToolGroupBlock from './EditToolGroupBlock';

const bridgeMocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  refreshFile: vi.fn(),
  showDiff: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  openFile: bridgeMocks.openFile,
  refreshFile: bridgeMocks.refreshFile,
  showDiff: bridgeMocks.showDiff,
}));

vi.mock('../../hooks/useResolvedFileLinkTooltip', () => ({
  useResolvedFileLinkTooltip: () => ({}),
}));

describe('EditToolGroupBlock', () => {
  beforeEach(() => {
    window.__deniedToolIds = new Set();
    bridgeMocks.openFile.mockReset();
    bridgeMocks.refreshFile.mockReset();
    bridgeMocks.showDiff.mockReset();
  });

  it('deduplicates equivalent absolute and relative edit rows and keeps navigation absolute', () => {
    render(
      <EditToolGroupBlock
        items={[
          {
            name: 'edit',
            input: {
              file_path: 'src/App.tsx',
              old_string: 'const value = 1',
              new_string: 'const value = 2',
            },
            result: { type: 'tool_result', content: 'ok' },
          },
          {
            name: 'edit',
            input: {
              file_path: '/repo/src/App.tsx',
              old_string: 'const value = 1',
              new_string: 'const value = 2',
            },
            result: { type: 'tool_result', content: 'ok' },
          },
        ]}
      />,
    );

    expect(screen.getByText('(1)')).toBeTruthy();
    expect(screen.queryByText('src/App.tsx')).toBeNull();

    fireEvent.click(screen.getByText('App.tsx'));

    expect(bridgeMocks.openFile).toHaveBeenCalledWith('/repo/src/App.tsx', undefined, undefined);
  });

  it('renders interrupted unresolved edits as error instead of pending', () => {
    window.__deniedToolIds = new Set(['edit-1']);

    const { container } = render(
      <EditToolGroupBlock
        items={[
          {
            name: 'edit',
            input: {
              file_path: 'src/App.tsx',
              old_string: 'const value = 1',
              new_string: 'const value = 2',
            },
            result: null,
            toolId: 'edit-1',
          },
        ]}
      />,
    );

    expect(container.querySelector('.tool-status-indicator.error')).toBeTruthy();
    expect(container.querySelector('.tool-status-indicator.pending')).toBeNull();
    expect(bridgeMocks.refreshFile).not.toHaveBeenCalled();
  });
});
