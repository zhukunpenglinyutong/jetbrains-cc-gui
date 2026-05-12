import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CommitSection from './index';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('CommitSection', () => {
  it('renders commit provider model controls above the prompt textarea', () => {
    const config: CommitAiConfig = {
      provider: null,
      effectiveProvider: 'codex',
      resolutionSource: 'auto',
      models: {
        claude: 'claude-sonnet-4-6',
        codex: 'gpt-5.5',
      },
      availability: {
        claude: true,
        codex: true,
      },
      generationMode: 'prompt',
      skillRef: 'builtin:git-commit',
      availableSkills: [],
    };

    render(
      <CommitSection
        commitAiConfig={config}
        onCommitAiProviderChange={vi.fn()}
        onCommitAiModelChange={vi.fn()}
        onCommitGenerationModeChange={vi.fn()}
        onCommitSkillChange={vi.fn()}
        onCommitAiResetToDefault={vi.fn()}
        commitPrompt="use english"
        onCommitPromptChange={vi.fn()}
        projectCommitPrompt=""
        onProjectCommitPromptChange={vi.fn()}
        onSaveCommitPrompt={vi.fn()}
        onSaveProjectCommitPrompt={vi.fn()}
        savingCommitPrompt={false}
        savingProjectCommitPrompt={false}
      />
    );

    expect(screen.getByText('settings.commit.title')).toBeTruthy();
    expect(screen.getByText('settings.commit.description')).toBeTruthy();
    expect(screen.getByTestId('commit-ai-provider-card')).toBeTruthy();
    expect(screen.getAllByRole('combobox')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'settings.commit.providerModel.resetToDefault' })).toBeTruthy();
    expect(screen.getByDisplayValue('use english')).toBeTruthy();
    expect(screen.queryByText('settings.commit.codeReview.label')).toBeNull();
  });

  it('shows skill selector when generation mode is skill', () => {
    const config: CommitAiConfig = {
      provider: null,
      effectiveProvider: 'codex',
      resolutionSource: 'auto',
      models: {
        claude: 'claude-sonnet-4-6',
        codex: 'gpt-5.5',
      },
      availability: {
        claude: true,
        codex: true,
      },
      generationMode: 'skill',
      skillRef: 'builtin:git-commit',
      availableSkills: [
        {
          ref: 'builtin:git-commit',
          name: 'git-commit',
          source: 'builtin',
          scope: 'builtin',
          enabled: true,
          builtin: true,
        },
      ],
    };

    render(
      <CommitSection
        commitAiConfig={config}
        onCommitAiProviderChange={vi.fn()}
        onCommitAiModelChange={vi.fn()}
        onCommitGenerationModeChange={vi.fn()}
        onCommitSkillChange={vi.fn()}
        onCommitAiResetToDefault={vi.fn()}
        commitPrompt="use english"
        projectCommitPrompt=""
        onCommitPromptChange={vi.fn()}
        onProjectCommitPromptChange={vi.fn()}
        onSaveCommitPrompt={vi.fn()}
        onSaveProjectCommitPrompt={vi.fn()}
        savingCommitPrompt={false}
        savingProjectCommitPrompt={false}
      />
    );

    expect(screen.getAllByRole('combobox')).toHaveLength(5);
    expect(screen.getByLabelText('settings.commit.skill.label')).toBeTruthy();
  });
});
