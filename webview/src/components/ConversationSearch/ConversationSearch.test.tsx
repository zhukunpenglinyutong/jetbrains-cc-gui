/**
 * Tests for the ConversationSearch panel UI.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationSearch } from './index';
import type { MessageListRevealHandle } from './types';

// Stub i18next so `t(key, { defaultValue })` returns the default text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; current?: number; total?: number; count?: number }) => {
      if (!options) return _key;
      if (options.defaultValue?.includes('{{current}}') && typeof options.current === 'number') {
        return `${options.current}/${options.total}`;
      }
      if (options.defaultValue?.includes('{{count}}') && typeof options.count === 'number') {
        return options.defaultValue.replace('{{count}}', String(options.count));
      }
      return options.defaultValue ?? _key;
    },
  }),
}));

function setupContainer(html: string): React.RefObject<HTMLDivElement> {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return { current: container } as React.RefObject<HTMLDivElement>;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // Clear persisted search options so each test starts fresh.
  try { window.localStorage.removeItem('cc-gui.search.options'); } catch { /* ignore */ }
  vi.useFakeTimers();
});

describe('ConversationSearch', () => {
  it('does not render when open=false', () => {
    const ref = setupContainer('<p>hi</p>');
    render(
      <ConversationSearch
        open={false}
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('renders input + buttons when open', () => {
    const ref = setupContainer('<p>hi</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Search in conversation/i)).toBeTruthy();
  });

  it('Esc key closes the panel', () => {
    const ref = setupContainer('<p>hello world</p>');
    const onClose = vi.fn();
    render(
      <ConversationSearch
        open
        onClose={onClose}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search in conversation/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter navigates to next match', () => {
    const ref = setupContainer(
      '<p>foo bar foo</p><p>another foo</p>',
    );
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'foo' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/3$/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(/^2\/3$/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(/^1\/3$/)).toBeTruthy();
  });

  it('Shift+Enter goes to previous', () => {
    const ref = setupContainer('<p>x y x y</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'x' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/2$/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByText(/^2\/2$/)).toBeTruthy();
  });

  it('invokes revealAll on the MessageList ref when query begins', () => {
    const ref = setupContainer('<p>hello</p>');
    const reveal: MessageListRevealHandle = { revealAll: vi.fn(() => 5) };
    const messageListRef = { current: reveal } as React.RefObject<MessageListRevealHandle>;
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
        messageListRef={messageListRef}
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'h' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(reveal.revealAll).toHaveBeenCalled();
  });

  it('shows "No results" message when query has no matches', () => {
    const ref = setupContainer('<p>hello world</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'absent' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText('No results')).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────
  //  Polish features (v0.4.4): toggles, persistence, regex error
  // ─────────────────────────────────────────────────────────

  it('Match Case toggle narrows the result count', () => {
    const ref = setupContainer('<p>Foo foo FOO</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'foo' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/3$/)).toBeTruthy();
    // Click Match Case toggle
    const matchCaseBtn = screen.getByLabelText(/Match Case/i);
    fireEvent.click(matchCaseBtn);
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/1$/)).toBeTruthy();
    expect(matchCaseBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('Alt+C shortcut toggles Match Case from the input', () => {
    const ref = setupContainer('<p>Foo foo FOO</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'foo' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/3$/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'c', altKey: true });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/1$/)).toBeTruthy();
  });

  it('Whole Word toggle narrows partial matches', () => {
    const ref = setupContainer('<p>cat catalog</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: 'cat' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/2$/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Whole Word/i));
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/1$/)).toBeTruthy();
  });

  it('Regex toggle interprets pattern characters', () => {
    const ref = setupContainer('<p>code 200, 404, 500</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.click(screen.getByLabelText(/^Regex$/i));
    fireEvent.change(input, { target: { value: '\\d{3}' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText(/^1\/3$/)).toBeTruthy();
  });

  it('shows "Invalid regex" when the pattern fails to compile', () => {
    const ref = setupContainer('<p>any text</p>');
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    fireEvent.click(screen.getByLabelText(/^Regex$/i));
    const input = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(input, { target: { value: '([a-z' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText('Invalid regex')).toBeTruthy();
  });

  it('persists toggle state to localStorage across remounts', () => {
    const ref = setupContainer('<p>hi</p>');
    const { unmount } = render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    // Flip Match Case on
    fireEvent.click(screen.getByLabelText(/Match Case/i));
    // Verify it was written to localStorage
    const raw = window.localStorage.getItem('cc-gui.search.options');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).matchCase).toBe(true);
    unmount();

    // Remount and confirm toggle is restored
    render(
      <ConversationSearch
        open
        onClose={() => {}}
        containerRef={ref}
        messagesSignal="1"
      />,
    );
    const restoredToggle = screen.getByLabelText(/Match Case/i);
    expect(restoredToggle.getAttribute('aria-pressed')).toBe('true');
  });
});
