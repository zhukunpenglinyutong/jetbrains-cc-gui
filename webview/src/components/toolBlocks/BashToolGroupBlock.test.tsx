import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BashToolGroupBlock from './BashToolGroupBlock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('BashToolGroupBlock', () => {
  it('keeps the batch header expandable without rendering a chevron icon', () => {
    const { container } = render(
      <BashToolGroupBlock
        items={[
          {
            toolId: 'bash-1',
            input: {
              command: 'npm test',
              description: 'Run tests',
            },
          },
        ]}
      />,
    );

    expect(container.querySelector('.bash-group-chevron')).toBeNull();
    expect(container.querySelector('.bash-group-timeline')).toBeTruthy();

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);

    expect(container.querySelector('.bash-group-timeline')).toBeNull();
  });

  it('renders command and stdout text in dedicated output nodes', () => {
    const { container } = render(
      <BashToolGroupBlock
        items={[
          {
            toolId: 'bash-1',
            input: {
              command: 'npm test',
            },
            result: {
              type: 'tool_result',
              content: 'stdout line 1\nstdout line 2',
            },
          },
        ]}
      />,
    );

    fireEvent.click(container.querySelector('.bash-timeline-content') as HTMLElement);

    expect(container.querySelector('.bash-command-block')?.textContent).toBe('npm test');
    const outputText = container.querySelector('.bash-output-text');
    expect(outputText).toBeTruthy();
    expect(outputText?.textContent).toBe('stdout line 1\nstdout line 2');
  });
});
