import { fireEvent, render, screen } from '@testing-library/react';
import StatusPanel from './StatusPanel';
import type { FileChangeSummary, SubagentInfo } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  openFile: vi.fn(),
  showEditableDiff: vi.fn(() => true),
  undoFileChanges: vi.fn(),
  sendToJava: vi.fn(),
}));

const fileChange: FileChangeSummary = {
  filePath: '/tmp/example.ts',
  fileName: 'example.ts',
  status: 'M',
  additions: 1,
  deletions: 1,
  operations: [
    {
      toolName: 'Edit',
      oldString: 'old',
      newString: 'new',
      additions: 1,
      deletions: 1,
    },
  ],
};

function renderFilesPanel(props: Partial<React.ComponentProps<typeof StatusPanel>> = {}) {
  render(
    <StatusPanel
      todos={[]}
      fileChanges={[fileChange]}
      subagents={[]}
      expanded
      isStreaming={false}
      {...props}
    />,
  );

  fireEvent.click(screen.getByText('statusPanel.editsTab'));
}

function getKeepAllButton() {
  const button = screen.getByText('statusPanel.keepAll').closest('button');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Keep All button not found');
  }
  return button;
}

describe('StatusPanel', () => {
  it('allows Keep All while a session-level subagent is pending', () => {
    renderFilesPanel({ hasPendingSubagent: true });

    expect(getKeepAllButton().disabled).toBe(false);
  });

  it('allows Keep All while a response is still streaming', () => {
    renderFilesPanel({ isStreaming: true });

    expect(getKeepAllButton().disabled).toBe(false);
  });

  it('allows Keep All when no stream or subagent scope is pending', () => {
    renderFilesPanel({ hasPendingSubagent: false });

    expect(getKeepAllButton().disabled).toBe(false);
  });

  it('counts error subagents as settled in the progress badge', () => {
    const subagents: SubagentInfo[] = [
      { id: 'a', type: 'worker', description: 'done 1', status: 'completed', messageIndex: 0 },
      { id: 'b', type: 'worker', description: 'done 2', status: 'completed', messageIndex: 0 },
      { id: 'c', type: 'worker', description: 'done 3', status: 'completed', messageIndex: 0 },
      { id: 'd', type: 'worker', description: 'invalid spawn', status: 'error', messageIndex: 0 },
    ];

    render(
      <StatusPanel
        todos={[]}
        fileChanges={[]}
        subagents={subagents}
        expanded
        isStreaming={false}
      />,
    );

    expect(screen.getByText('4/4')).toBeTruthy();
  });

});
