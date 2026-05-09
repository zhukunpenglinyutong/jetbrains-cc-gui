import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GenericToolBlock from './GenericToolBlock';

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

describe('GenericToolBlock', () => {
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
});
