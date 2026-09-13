import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatInputBoxHeader } from './ChatInputBoxHeader';

vi.mock('../../contexts/UIStateContext', () => ({
  useUIState: () => ({ addToast: vi.fn() }),
}));

const createProps = (): ComponentProps<typeof ChatInputBoxHeader> => ({
  sdkInstalled: true,
  sdkStatusLoading: false,
  sdkStatusError: false,
  currentProvider: 'codex',
  t: ((key: string) => key) as never,
  attachments: [],
  onRemoveAttachment: vi.fn(),
  usagePercentage: 0,
  showUsage: false,
  onAddAttachment: vi.fn(),
  onClearAgent: vi.fn(),
  hasMessages: false,
  statusPanelExpanded: false,
});

describe('ChatInputBoxHeader SDK status', () => {
  it('shows a retry action for query errors without showing the install warning', () => {
    const onRetrySdkStatus = vi.fn();
    render(
      <ChatInputBoxHeader
        {...createProps()}
        sdkStatusError
        onRetrySdkStatus={onRetrySdkStatus}
      />,
    );

    expect(screen.getByText('chat.sdkStatusUnavailable')).toBeTruthy();
    expect(screen.queryByText('chat.sdkNotInstalled')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'chat.retrySdkStatus' }));

    expect(onRetrySdkStatus).toHaveBeenCalledTimes(1);
  });
});
