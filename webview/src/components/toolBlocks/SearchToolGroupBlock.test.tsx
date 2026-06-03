import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SearchToolGroupBlock from './SearchToolGroupBlock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('SearchToolGroupBlock', () => {
  beforeEach(() => {
    window.__deniedToolIds = new Set();
  });

  it('renders interrupted unresolved searches as error instead of pending', () => {
    window.__deniedToolIds = new Set(['search-2']);

    const { container } = render(
      <SearchToolGroupBlock
        items={[
          {
            name: 'grep',
            input: { pattern: 'needle', path: 'src' },
            result: { type: 'tool_result', content: 'found' },
            toolId: 'search-1',
          },
          {
            name: 'glob',
            input: { pattern: '**/*.ts', path: 'webview' },
            result: null,
            toolId: 'search-2',
          },
        ]}
      />,
    );

    const indicators = [...container.querySelectorAll('.tool-status-indicator')];
    expect(indicators).toHaveLength(2);
    expect(indicators[0].classList.contains('completed')).toBe(true);
    expect(indicators[1].classList.contains('error')).toBe(true);
    expect(container.querySelector('.tool-status-indicator.pending')).toBeNull();
  });
});
