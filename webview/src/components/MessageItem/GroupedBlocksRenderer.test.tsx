import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock } from '../../types';
import { GroupedBlocksRenderer } from './GroupedBlocksRenderer';
import { groupBlocks } from './groupBlocks';
import {
  BASH_GROUP_COLLAPSED_KEY,
  setBashGroupCollapsedByDefault,
} from '../../utils/bashGroupCollapsePreference';
import {
  EDIT_GROUP_COLLAPSED_KEY,
  setEditGroupCollapsedByDefault,
} from '../../utils/editGroupCollapsePreference';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../utils/bridge', () => ({
  openFile: vi.fn(),
  showDiff: vi.fn(),
  refreshFile: vi.fn(),
  sendToJava: vi.fn(),
}));
vi.mock('../../hooks/useResolvedFileLinkTooltip', () => ({
  useResolvedFileLinkTooltip: (filePath: string) => ({ title: filePath }),
}));

function renderGroups(provider: string, blocks: ClaudeContentBlock[]) {
  const props: ComponentProps<typeof GroupedBlocksRenderer> = {
    message: { type: 'assistant', raw: { content: blocks } },
    messageIndex: 0,
    messageKey: 'message-1',
    t: ((key: string) => key) as TFunction,
    getMessageText: () => '',
    findToolResult: () => undefined,
    isProviderNotConfigured: false,
    errorDiagnosticPattern: null,
    isEmptyStreamingPlaceholder: false,
    currentProvider: provider,
    groupedBlocks: groupBlocks(blocks),
    renderedBlockCount: blocks.length,
    isMessageStreaming: true,
    isThinking: false,
    isLast: true,
    isThinkingExpanded: () => false,
    onToggleThinking: vi.fn(),
  };
  return render(<GroupedBlocksRenderer {...props} />);
}

describe('GroupedBlocksRenderer shared CLI collapse preferences', () => {
  beforeEach(() => {
    localStorage.removeItem(BASH_GROUP_COLLAPSED_KEY);
    localStorage.removeItem(EDIT_GROUP_COLLAPSED_KEY);
  });

  const providers = ['claude', 'codex', 'grok', 'kimi', 'opencode', 'pi', 'omp', 'minimax', 'zcode'];

  it.each(providers)('uses the command preference for %s command groups', (provider) => {
    setBashGroupCollapsedByDefault(true);
    const blocks: ClaudeContentBlock[] = [
      'Bash', 'run_terminal_cmd', 'exec_command', 'execute_command', 'shell_command',
    ].map((name, index) => ({
      type: 'tool_use', id: `command-${index}`, name, input: { command: `echo ${index}` },
    }));
    const { container } = renderGroups(provider, blocks);
    expect(container.querySelector('.bash-group-header')?.textContent).toContain('(5)');
    expect(container.querySelector('.bash-group-timeline')).toBeNull();

    act(() => setBashGroupCollapsedByDefault(false));
    expect(container.querySelectorAll('.bash-timeline-item')).toHaveLength(5);
  });

  it.each(providers)('uses an independent preference for %s file edit groups', (provider) => {
    setEditGroupCollapsedByDefault(true);
    const blocks: ClaudeContentBlock[] = [
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'echo one' } },
      { type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'echo two' } },
      { type: 'tool_use', id: 'edit-1', name: 'Edit', input: {
        file_path: '/project/one.ts', old_string: 'old', new_string: 'new',
      } },
      { type: 'tool_use', id: 'edit-2', name: 'Edit', input: {
        file_path: '/project/two.ts', old_string: 'old', new_string: 'new',
      } },
    ];
    const { container, getByText } = renderGroups(provider, blocks);
    expect(container.querySelectorAll('.bash-timeline-item')).toHaveLength(2);
    expect(container.querySelector('.file-list-container')).toBeNull();

    act(() => setEditGroupCollapsedByDefault(false));
    expect(container.querySelectorAll('.file-list-item')).toHaveLength(2);
    fireEvent.click(getByText('tools.editBatchTitle').closest('.task-header') as HTMLElement);
    expect(container.querySelector('.file-list-container')).toBeNull();
    expect(container.querySelectorAll('.bash-timeline-item')).toHaveLength(2);
  });
});
