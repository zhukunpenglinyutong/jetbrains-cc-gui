import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReadToolGroupBlock from './ReadToolGroupBlock';

const bridgeMocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  resolveFilePathWithCallback: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  openFile: bridgeMocks.openFile,
  resolveFilePathWithCallback: bridgeMocks.resolveFilePathWithCallback,
}));

describe('ReadToolGroupBlock', () => {
  beforeEach(() => {
    bridgeMocks.openFile.mockReset();
    bridgeMocks.resolveFilePathWithCallback.mockReset();
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callback('src/App.tsx');
    });
    document.querySelectorAll('.file-link-tooltip').forEach((element) => element.remove());
  });

  it('uses custom lazy tooltip instead of native title for file rows', () => {
    render(
      <ReadToolGroupBlock
        items={[
          {
            input: { file_path: '/repo/src/App.tsx' },
            result: { type: 'tool_result', content: 'content' },
          },
        ]}
      />,
    );

    const fileRow = screen.getByText('App.tsx').closest('.file-list-item') as HTMLElement;

    expect(fileRow.getAttribute('title')).toBeNull();
    expect(bridgeMocks.resolveFilePathWithCallback).not.toHaveBeenCalled();

    fireEvent.mouseEnter(fileRow, { clientX: 10, clientY: 20 });

    expect(bridgeMocks.resolveFilePathWithCallback).toHaveBeenCalledWith('/repo/src/App.tsx', expect.any(Function));
    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('src/App.tsx');
  });

  it('keeps a full-path tooltip for directory rows without resolving through backend', () => {
    render(
      <ReadToolGroupBlock
        items={[
          {
            input: { path: 'src/components/' },
            result: { type: 'tool_result', content: 'content' },
          },
        ]}
      />,
    );

    const directoryRow = screen.getByText('src/components/').closest('.file-list-item') as HTMLElement;

    expect(directoryRow.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(directoryRow, { clientX: 10, clientY: 20 });

    expect(bridgeMocks.resolveFilePathWithCallback).not.toHaveBeenCalled();
    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('src/components/');
  });
});
