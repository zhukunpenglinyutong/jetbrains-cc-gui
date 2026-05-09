import { act, fireEvent, render } from '@testing-library/react';
import TaskExecutionBlock from './TaskExecutionBlock';

const mockSendBridgeEvent = vi.fn();
const mockGetSubagentHistory = vi.fn<(key: string) => unknown>();
const mockUseSessionId = vi.fn<() => string | null>();
const mockGetToolResultRaw = vi.fn<(toolUseId: string) => Record<string, unknown> | null>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => mockSendBridgeEvent(...args),
}));

vi.mock('../../contexts/SubagentContext', () => ({
  useSubagentHistoryGetter: () => mockGetSubagentHistory,
  useSessionId: () => mockUseSessionId(),
  useGetToolResultRaw: () => mockGetToolResultRaw,
}));

describe('TaskExecutionBlock polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSendBridgeEvent.mockReset();
    mockGetSubagentHistory.mockReset();
    mockGetToolResultRaw.mockReset();
    mockUseSessionId.mockReset();

    mockGetSubagentHistory.mockReturnValue(undefined);
    mockGetToolResultRaw.mockReturnValue(null);
    mockUseSessionId.mockReturnValue('session-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start polling when the agent tool is no longer streaming', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    const { container } = render(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        isStreaming={false}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('keeps the task header expandable without rendering a chevron icon', () => {
    const { container } = render(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    expect(container.querySelector('.task-chevron')).toBeNull();

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(container.querySelector('.task-details')).toBeTruthy();
  });

  it('stops polling once a tool result marks the agent task completed', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const { container, rerender } = render(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        isStreaming={true}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(mockSendBridgeEvent).toHaveBeenCalledWith(
      'load_subagent_session',
      expect.stringContaining('"toolUseId":"task-1"'),
    );

    rerender(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        isStreaming={true}
        result={{ type: 'tool_result', tool_use_id: 'task-1', content: 'done' } as any}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    expect(clearIntervalSpy).toHaveBeenCalled();

    mockSendBridgeEvent.mockClear();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(mockSendBridgeEvent).not.toHaveBeenCalled();
  });
});
