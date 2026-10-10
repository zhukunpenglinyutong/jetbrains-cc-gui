import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BashToolGroupBlock from './BashToolGroupBlock';
import {
  BASH_GROUP_COLLAPSED_KEY,
  setBashGroupCollapsedByDefault,
} from '../../utils/bashGroupCollapsePreference';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('BashToolGroupBlock', () => {
  beforeEach(() => localStorage.removeItem(BASH_GROUP_COLLAPSED_KEY));

  it('starts collapsed when configured and preserves manual expansion during updates', () => {
    setBashGroupCollapsedByDefault(true);
    const { container, rerender } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { command: 'npm test' } }]} />,
    );
    expect(container.querySelector('.bash-group-timeline')).toBeNull();
    expect(container.querySelector('.bash-group-header')?.textContent).toContain('(1)');
    expect(container.querySelector('.bash-group-progress')?.textContent).toContain('0/1');

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);
    expect(container.querySelector('.bash-group-timeline')).toBeTruthy();

    rerender(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' }, result: { type: 'tool_result', content: 'passed' } },
        { toolId: 'bash-2', input: { command: 'npm run build' } },
      ]} />,
    );
    expect(container.querySelectorAll('.bash-timeline-item')).toHaveLength(2);
    expect(container.querySelector('.bash-group-progress')?.textContent).toContain('1/2');

    act(() => setBashGroupCollapsedByDefault(false));
    act(() => setBashGroupCollapsedByDefault(true));
    expect(container.querySelector('.bash-group-timeline')).toBeTruthy();

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);
    expect(container.querySelector('.bash-group-timeline')).toBeNull();
  });

  it('applies preference changes live until the group is manually toggled', () => {
    const { container } = render(
      <BashToolGroupBlock items={[{ toolId: 'bash-1', input: { command: 'npm test' } }]} />,
    );
    expect(container.querySelector('.bash-group-timeline')).toBeTruthy();

    act(() => setBashGroupCollapsedByDefault(true));
    expect(container.querySelector('.bash-group-timeline')).toBeNull();

    act(() => setBashGroupCollapsedByDefault(false));
    expect(container.querySelector('.bash-group-timeline')).toBeTruthy();

    fireEvent.click(container.querySelector('.bash-group-header') as HTMLElement);
    act(() => setBashGroupCollapsedByDefault(true));
    act(() => setBashGroupCollapsedByDefault(false));
    expect(container.querySelector('.bash-group-timeline')).toBeNull();
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

    expect(container.querySelector('.bash-group-header')?.textContent).toContain('(1)');
    expect(container.querySelectorAll('.bash-timeline-item')).toHaveLength(1);
    expect(container.querySelector('.bash-timeline-description')?.textContent).toBe('npm test');
  });

  it.each(['Enter', ' '])('allows keyboard expansion and collapse with %j', (key) => {
    setBashGroupCollapsedByDefault(true);
    const { container, getByRole } = render(
      <BashToolGroupBlock items={[
        { toolId: 'bash-1', input: { command: 'npm test' } },
        { toolId: 'bash-2', input: { command: 'npm run build' } },
      ]} />,
    );
    const header = getByRole('button', { expanded: false });
    expect(header.tabIndex).toBe(0);
    expect(fireEvent.keyDown(header, { key })).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.bash-timeline-item')).toHaveLength(2);
    expect(fireEvent.keyDown(header, { key })).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.bash-group-timeline')).toBeNull();

    act(() => setBashGroupCollapsedByDefault(false));
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

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
