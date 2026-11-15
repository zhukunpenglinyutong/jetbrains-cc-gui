import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import type { HistorySessionSummary } from '../../types';
import { HistoryItemTitle } from './HistoryItemTitle';

vi.mock('../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

const renderTitle = (provider: string) => {
  const session: HistorySessionSummary = { sessionId: 's1', title: 'A session', provider };
  return render(
    <HistoryItemTitle
      session={session}
      isEditing={false}
      editingTitle=""
      searchQuery=""
      t={((key: string) => key) as unknown as TFunction}
      onEditSave={() => {}}
      onEditCancel={() => {}}
      onEditTitleChange={() => {}}
    />,
  );
};

describe('HistoryItemTitle provider badge', () => {
  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['omp', 'OMP CLI'],
    ['dsh', 'DeepSeek Harness'],
  ])('titles a %s session with its provider label', (provider, label) => {
    const { container } = renderTitle(provider);
    expect(screen.getByTestId('provider-icon')).toBeTruthy();
    expect(container.querySelector('.history-provider-badge')?.getAttribute('title')).toBe(label);
  });
});
