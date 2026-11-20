import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatHeader } from './ChatHeader';
import type { ChatHeaderProps } from './ChatHeader';

const t = ((key: string) => key) as ChatHeaderProps['t'];

const baseProps = {
  currentView: 'chat' as const,
  sessionTitle: 'Fix login button',
  t,
  onBack: vi.fn(),
  onNewSession: vi.fn(),
  onNewTab: vi.fn(),
  onHistory: vi.fn(),
  onSettings: vi.fn(),
};

describe('ChatHeader title regeneration button', () => {
  it('renders the refresh button after the title and fires it on click', () => {
    const onRegenerateTitle = vi.fn();
    render(<ChatHeader {...baseProps} titleEditable onRegenerateTitle={onRegenerateTitle} />);

    const button = screen.getByRole('button', { name: 'history.regenerateTitle' });
    fireEvent.click(button);
    expect(onRegenerateTitle).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the button and shows the spinner while a regeneration is in flight', () => {
    render(
      <ChatHeader
        {...baseProps}
        titleEditable
        onRegenerateTitle={vi.fn()}
        isRegeneratingTitle
      />,
    );

    const button = screen.getByRole('button', { name: 'history.regenerateTitle' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).toContain('is-loading');

    fireEvent.click(button); // disabled buttons do not fire onClick in the browser
    expect(screen.getByRole('button', { name: 'history.regenerateTitle' })).toBe(button);
  });

  it('hides the button when no regeneration callback is provided', () => {
    render(<ChatHeader {...baseProps} titleEditable />);
    expect(screen.queryByRole('button', { name: 'history.regenerateTitle' })).toBeNull();
  });

  it('hides the title area (and the button) on the history view', () => {
    render(
      <ChatHeader {...baseProps} currentView="history" onRegenerateTitle={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'history.regenerateTitle' })).toBeNull();
  });
});
