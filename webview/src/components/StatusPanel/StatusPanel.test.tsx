import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StatusPanel from './StatusPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('StatusPanel', () => {
  it.each([
    ['codex', 'statusPanel.todoTab'],
    ['claude', 'statusPanel.tasksTab'],
  ])('uses the provider-specific todo label for %s', (currentProvider, expectedLabel) => {
    render(
      <StatusPanel
        todos={[]}
        fileChanges={[]}
        subagents={[]}
        currentProvider={currentProvider}
      />,
    );

    expect(screen.getByText(expectedLabel)).toBeTruthy();
  });
});
