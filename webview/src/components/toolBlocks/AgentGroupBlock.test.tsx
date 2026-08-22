import { fireEvent, render } from '@testing-library/react';
import type { ClaudeContentBlock } from '../../types';
import AgentGroupBlock from './AgentGroupBlock';

const mockSendBridgeEvent = vi.fn();
let mockHistories: Record<string, unknown> = {};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => mockSendBridgeEvent(...args),
}));

vi.mock('../../utils/expandedState', () => ({
  getPersistedExpanded: () => false,
  setPersistedExpanded: () => undefined,
}));

vi.mock('../../contexts/SubagentContext', () => ({
  useSubagentHistories: () => mockHistories,
  useSessionId: () => 'session-1',
  useSessionProvider: () => 'codex',
  useGetToolResultRaw: () => () => null,
  useTaskEvent: () => undefined,
}));

vi.mock('../MessageItem/ContentBlockRenderer', () => ({
  ContentBlockRenderer: () => null,
}));

describe('AgentGroupBlock', () => {
  beforeEach(() => {
    mockSendBridgeEvent.mockReset();
    mockHistories = {};
  });

  it('uses safe spawn identity and loads details from a status-only snapshot', () => {
    const opaqueMessage = 'gAAAAABopaque-transport-content';
    mockHistories = { 'call-agent-group': { success: true, status: 'running' } };
    const agentBlock = {
      type: 'tool_use',
      id: 'call-agent-group',
      name: 'spawn_agent',
      input: { task_name: '/root/reviewer', message: opaqueMessage, prompt: opaqueMessage },
    } as ClaudeContentBlock;

    const { container } = render(
      <AgentGroupBlock
        agentBlock={agentBlock}
        followingBlocks={[]}
        messageIndex={0}
        isStreaming={false}
        isLastMessage
        isThinking={false}
        findToolResult={() => null}
      />,
    );

    expect(container.querySelector('.task-header')?.textContent).toContain('reviewer');
    expect(container.textContent).not.toContain(opaqueMessage);

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    expect(mockSendBridgeEvent).toHaveBeenCalledWith(
      'load_subagent_session',
      expect.stringContaining('"toolUseId":"call-agent-group"'),
    );
  });
});
