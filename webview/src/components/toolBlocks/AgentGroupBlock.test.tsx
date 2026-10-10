import { fireEvent, render } from '@testing-library/react';
import type { ClaudeContentBlock } from '../../types';
import AgentGroupBlock from './AgentGroupBlock';

const mockSendBridgeEvent = vi.fn();
let mockHistories: Record<string, unknown> = {};
let mockSubagentStates: Array<Record<string, unknown>> = [];

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
  useSubagentStates: () => mockSubagentStates,
}));

vi.mock('../MessageItem/ContentBlockRenderer', () => ({
  ContentBlockRenderer: () => null,
}));

describe('AgentGroupBlock', () => {
  beforeEach(() => {
    mockSendBridgeEvent.mockReset();
    mockHistories = {};
    mockSubagentStates = [];
  });

  it.each([1, 2])('shows the native prompt in each of %i child process cards', childCount => {
    const prompt = 'Inspect the compact request and report its terminal result.';
    if (childCount > 1) mockSubagentStates = Array.from({ length: childCount }, (_, index) => ({
      id: `native-child-${index}`, agentId: `child-${index}`, type: 'review', description: '',
      status: 'running', isAsync: true, messageIndex: 0, prompt,
    }));
    const { container } = render(<AgentGroupBlock
      agentBlock={{ type: 'tool_use', id: 'native-spawn', name: 'spawn_agent', input: { native: true, prompt } }}
      followingBlocks={[]} messageIndex={0} isStreaming isLastMessage isThinking={false}
      findToolResult={() => null} />);
    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    expect(Array.from(container.querySelectorAll('.subagent-prompt-card'), card => card.textContent))
      .toEqual(Array(childCount).fill(prompt));
  });

  it('shares native completion and report with the StatusPanel instead of showing a launch receipt', () => {
    mockSubagentStates = [{ id: 'native-spawn', type: 'reviewer', description: '', status: 'completed',
      isAsync: true, messageIndex: 0, agentId: 'native-child', agentPath: '/root/reviewer', resultText: 'Review finished' }];
    const { container } = render(<AgentGroupBlock
      agentBlock={{ type: 'tool_use', id: 'native-spawn', name: 'spawn_agent', input: { task_name: 'reviewer' } } as ClaudeContentBlock}
      followingBlocks={[]} messageIndex={0} isStreaming={false} isLastMessage isThinking={false}
      findToolResult={() => ({ type: 'tool_result', tool_use_id: 'native-spawn', content: '{"task_name":"/root/reviewer"}' })}
    />);
    expect(container.querySelector('.tool-status-indicator.completed')).not.toBeNull();
    expect(container.querySelector('.tool-title-text')?.textContent).toBe('tools.agent');
    fireEvent.click(container.querySelector('.task-header') as HTMLElement);
    expect(container.textContent).toContain('Review finished');
    expect(container.textContent).toContain('/root/reviewer');
    expect(container.textContent).not.toContain('{"task_name"');
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
