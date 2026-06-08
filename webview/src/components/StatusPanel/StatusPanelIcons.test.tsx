import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileChangesList from './FileChangesList';
import UndoConfirmDialog from './UndoConfirmDialog';
import DiscardAllDialog from './DiscardAllDialog';
import SubagentProcessDetails from './SubagentProcessDetails';
import type { FileChangeSummary, SubagentHistoryResponse } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options?.count != null) return `${key}:${options.count}`;
      return key;
    },
  }),
}));

vi.mock('../../utils/bridge', () => ({
  showEditableDiff: vi.fn(),
  openFile: vi.fn(),
  sendBridgeEvent: vi.fn(),
}));

const sampleFileChange: FileChangeSummary = {
  filePath: 'webview/src/components/StatusPanel/FileChangesList.tsx',
  fileName: 'FileChangesList.tsx',
  status: 'M',
  additions: 4,
  deletions: 2,
  lineStart: 1,
  lineEnd: 10,
  operations: [
    {
      oldString: 'old',
      newString: 'new',
      replaceAll: false,
    },
  ],
};

describe('StatusPanel icon migration', () => {
  it('FileChangesList renders SVG icons instead of codicon spans', () => {
    const { container } = render(
      <FileChangesList
        fileChanges={[sampleFileChange]}
        undoingFile={null}
        isDiscardingAll={false}
        onUndoClick={() => {}}
        onDiscardAllClick={() => {}}
        onKeepAllClick={() => {}}
      />,
    );

    expect(container.querySelector('.codicon')).toBeNull();
    expect(container.querySelectorAll('button svg').length).toBeGreaterThanOrEqual(4);
  });

  it('UndoConfirmDialog renders SVG header icon instead of codicon span', () => {
    const { container } = render(
      <UndoConfirmDialog
        fileChange={sampleFileChange}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('statusPanel.undoConfirmTitle')).toBeTruthy();
    expect(container.querySelector('.undo-confirm-header svg')).toBeTruthy();
    expect(container.querySelector('.undo-confirm-header .codicon')).toBeNull();
  });

  it('DiscardAllDialog renders SVG header icon instead of codicon span', () => {
    const { container } = render(
      <DiscardAllDialog
        visible
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('statusPanel.discardAllConfirmTitle')).toBeTruthy();
    expect(container.querySelector('.undo-confirm-header svg')).toBeTruthy();
    expect(container.querySelector('.undo-confirm-header .codicon')).toBeNull();
  });

  it('SubagentProcessDetails renders SVG section icons instead of codicon spans', () => {
    const history: SubagentHistoryResponse = {
      success: true,
      messages: [
        {
          type: 'assistant',
          content: [
            { type: 'text', text: '检查剩余图标替换点' },
            { type: 'tool_use', name: 'read', input: { file_path: 'webview/src/components/StatusPanel/FileChangesList.tsx' } },
            { type: 'tool_use', name: 'search', input: { pattern: 'codicon' } },
          ],
        },
      ],
    } as SubagentHistoryResponse;

    const { container } = render(
      <SubagentProcessDetails
        agentId="agent-1"
        totalDurationMs={1500}
        totalTokens={1200}
        totalToolUseCount={2}
        resultText="已整理剩余图标点"
        history={history}
        canLoad
      />,
    );

    expect(container.querySelector('.codicon')).toBeNull();
    expect(container.querySelectorAll('.subagent-section-heading svg').length).toBeGreaterThanOrEqual(3);
  });
});
