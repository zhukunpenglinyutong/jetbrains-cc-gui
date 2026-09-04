import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeminiIdleReapCard from './GeminiIdleReapCard';

const translations: Record<string, string> = {
  'settings.gemini.idleReapLabel': 'Stop silent turns automatically',
  'settings.gemini.idleReapHelp':
    'Ends a Gemini turn that has produced no output for this many minutes. 0 disables automatic stopping.',
  'settings.gemini.idleReapDisabled': 'Disabled',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe('GeminiIdleReapCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
    window.updateGeminiIdleReapMinutes = undefined;
  });

  afterEach(() => {
    window.sendToJava = undefined;
    window.updateGeminiIdleReapMinutes = undefined;
  });

  const pushMinutes = (value: number | string) => {
    act(() => {
      window.updateGeminiIdleReapMinutes?.(
        typeof value === 'number' ? JSON.stringify({ geminiIdleReapMinutes: value }) : value,
      );
    });
  };

  const sentMessages = () => (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0],
  );

  it('requests the current window from Java on mount', () => {
    render(<GeminiIdleReapCard />);
    expect(window.sendToJava).toHaveBeenCalledWith('get_gemini_idle_reap_minutes');
  });

  it('stays disabled until Java answers, then shows the loaded value', () => {
    render(<GeminiIdleReapCard />);
    const input = screen.getByRole('spinbutton', {
      name: 'Stop silent turns automatically',
    }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('');

    pushMinutes(30);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('30');
    expect(screen.queryByText('Disabled')).toBeNull();
  });

  it('shows the disabled badge when the window is 0', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(0);

    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('0');
    expect(screen.getByText('Disabled')).toBeTruthy();
  });

  it('persists an edited value immediately and survives the Java echo', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(30);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '45' } });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_gemini_idle_reap_minutes:{"geminiIdleReapMinutes":45}',
    );
    expect(input.value).toBe('45');

    pushMinutes(45);
    expect(input.value).toBe('45');
  });

  it('ignores malformed or negative echoes and never sends empty or negative edits', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(30);
    expect(sentMessages()).toEqual(['get_gemini_idle_reap_minutes']);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    pushMinutes('not-json');
    pushMinutes(JSON.stringify({ geminiIdleReapMinutes: -5 }));
    expect(input.value).toBe('30');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '-3' } });
    expect(sentMessages()).toEqual(['get_gemini_idle_reap_minutes']);

    pushMinutes(60);
    expect(input.value).toBe('60');
  });
});
