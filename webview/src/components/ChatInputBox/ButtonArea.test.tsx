import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendBridgeEvent } from '../../utils/bridge';
import ButtonArea from './ButtonArea';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

vi.mock('./selectors', () => ({
  ConfigSelect: () => <div data-testid="config-select" />,
  ProviderSelect: () => <div data-testid="provider-select" />,
  ModeSelect: () => <div data-testid="mode-select" />,
  ReasoningSelect: () => <div data-testid="reasoning-select" />,
  ModelSelect: ({ models }: { models: Array<{ id: string }> }) => (
    <div data-testid="model-select">{models.map(model => model.id).join(',')}</div>
  ),
}));

const mockedSendBridgeEvent = vi.mocked(sendBridgeEvent);

describe('ButtonArea OpenCode model discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedSendBridgeEvent.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    delete window.updateOpenCodeModels;
  });

  it('retries the OpenCode model request until the bridge accepts it', () => {
    mockedSendBridgeEvent
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    render(<ButtonArea currentProvider="opencode" selectedModel="opencode-default" />);

    expect(mockedSendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(mockedSendBridgeEvent).toHaveBeenLastCalledWith('get_opencode_models');

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(mockedSendBridgeEvent).toHaveBeenCalledTimes(2);
    expect(mockedSendBridgeEvent).toHaveBeenLastCalledWith('get_opencode_models');

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(mockedSendBridgeEvent).toHaveBeenCalledTimes(3);
    expect(mockedSendBridgeEvent).toHaveBeenLastCalledWith('get_opencode_models');

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(mockedSendBridgeEvent).toHaveBeenCalledTimes(3);
  });

  it('stops retrying when the toolbar unmounts', () => {
    mockedSendBridgeEvent.mockReturnValue(false);

    const { unmount } = render(<ButtonArea currentProvider="opencode" selectedModel="opencode-default" />);

    expect(mockedSendBridgeEvent).toHaveBeenCalledTimes(1);
    unmount();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(mockedSendBridgeEvent).toHaveBeenCalledTimes(1);
  });

  it('applies discovered OpenCode models from the bridge callback', () => {
    mockedSendBridgeEvent.mockReturnValue(true);

    render(<ButtonArea currentProvider="opencode" selectedModel="openai/gpt-5.5" />);

    act(() => {
      window.updateOpenCodeModels?.(JSON.stringify({
        success: true,
        models: [
          { id: 'opencode-default', label: 'opencode default' },
          { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
          { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
        ],
      }));
    });

    expect(screen.getByTestId('model-select').textContent).toBe(
      'opencode-default,openai/gpt-5.5,anthropic/claude-sonnet-4-5',
    );
  });
});
