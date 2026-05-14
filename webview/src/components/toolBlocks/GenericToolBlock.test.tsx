import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GenericToolBlock from './GenericToolBlock';

const hookMocks = vi.hoisted(() => ({
  useResolvedFileLinkTooltip: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/useIsToolDenied', () => ({
  useIsToolDenied: () => false,
}));

vi.mock('../../utils/bridge', () => ({
  openFile: vi.fn(),
}));

vi.mock('../../hooks/useResolvedFileLinkTooltip', () => ({
  useResolvedFileLinkTooltip: hookMocks.useResolvedFileLinkTooltip,
}));

describe('GenericToolBlock', () => {
  beforeEach(() => {
    hookMocks.useResolvedFileLinkTooltip.mockReset();
    hookMocks.useResolvedFileLinkTooltip.mockReturnValue({});
  });

  it('keeps search-style tools expandable without showing a chevron icon', () => {
    const { container } = render(
      <GenericToolBlock
        name="glob"
        input={{
          pattern: 'session',
          path: '/tmp',
          case_sensitive: true,
        }}
      />,
    );

    expect(container.querySelector('.tool-chevron')).toBeNull();
    expect(container.querySelector('.task-details-accordion')?.classList.contains('expanded')).toBe(false);

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(container.querySelector('.task-details-accordion')?.classList.contains('expanded')).toBe(true);
    expect(screen.getByText('case_sensitive')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
  });

  it('keeps other expandable generic tools clickable without showing a chevron icon', () => {
    const { container } = render(
      <GenericToolBlock
        name="webfetch"
        input={{
          url: 'https://example.com',
          prompt: 'Summarize this page',
        }}
      />,
    );

    expect(container.querySelector('.tool-chevron')).toBeNull();

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(container.querySelector('.task-details-accordion')?.classList.contains('expanded')).toBe(true);
    expect(screen.getByText('prompt')).toBeTruthy();
    expect(screen.getByText('Summarize this page')).toBeTruthy();
  });

  it('configures each apply_patch file link independently', () => {
    render(
      <GenericToolBlock
        name="apply_patch"
        input={{
          input: [
            '*** Begin Patch',
            '*** Update File: webview/src/App.tsx',
            '@@',
            '*** Update File: webview/src/main.tsx',
            '@@',
            '*** End Patch',
          ].join('\n'),
        }}
      />,
    );

    expect(hookMocks.useResolvedFileLinkTooltip).toHaveBeenCalledWith('webview/src/App.tsx', 'webview/src/App.tsx');
    expect(hookMocks.useResolvedFileLinkTooltip).toHaveBeenCalledWith('webview/src/main.tsx', 'webview/src/main.tsx');
  });

  it('does not pass unresolved absolute apply_patch paths to tooltip text', () => {
    const absolutePath = 'C:\\Users\\me\\.ssh\\config';

    render(
      <GenericToolBlock
        name="apply_patch"
        input={{
          input: [
            '*** Begin Patch',
            `*** Update File: ${absolutePath}`,
            '@@',
            '*** End Patch',
          ].join('\n'),
        }}
      />,
    );

    expect(hookMocks.useResolvedFileLinkTooltip).toHaveBeenCalledWith(absolutePath, undefined);
  });
});
