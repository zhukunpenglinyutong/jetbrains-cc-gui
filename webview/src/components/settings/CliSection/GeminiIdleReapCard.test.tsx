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

  const commitSets = () => sentMessages().filter((m) => String(m).startsWith('set_gemini_idle_reap_minutes:'));

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

  it('commits on blur, never per keystroke (review fix M2)', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(30);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    // Editing 30→45 via select-all + typing: every intermediate draft ("4")
    // stays local. A per-keystroke regression persists "4" — a 1-digit window
    // that kills healthy 20-minute silent turns — and fails this test here.
    fireEvent.change(input, { target: { value: '4' } });
    expect(commitSets()).toEqual([]);
    fireEvent.change(input, { target: { value: '45' } });
    expect(commitSets()).toEqual([]);

    fireEvent.blur(input);
    expect(commitSets()).toEqual(['set_gemini_idle_reap_minutes:{"geminiIdleReapMinutes":45}']);
    expect(input.value).toBe('45');

    // The authoritative Java echo re-syncs without disturbing the value.
    pushMinutes(45);
    expect(input.value).toBe('45');
  });

  it('commits on Enter and never on intermediate keystrokes', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(30);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '60' } });
    expect(commitSets()).toEqual([]);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(commitSets()).toEqual(['set_gemini_idle_reap_minutes:{"geminiIdleReapMinutes":60}']);
    expect(input.value).toBe('60');
  });

  it('Escape reverts the draft to the authoritative value and sends nothing', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(30);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('30');
    expect(commitSets()).toEqual([]);

    // The reverted draft is canonical: a later blur commits nothing.
    fireEvent.blur(input);
    expect(commitSets()).toEqual([]);
  });

  it('clamps commits into [0, 1440] — out-of-range and negative edits are bounded', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(30);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    // Above the max (one day of silence): clamps to 1440 instead of handing
    // Java a >2^31 value its Gson getAsInt() could narrow to a negative.
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.blur(input);
    expect(commitSets()).toEqual(['set_gemini_idle_reap_minutes:{"geminiIdleReapMinutes":1440}']);
    expect(input.value).toBe('1440');

    // Negative: clamps to 0 = disabled (same direction as the Java setter).
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.blur(input);
    expect(commitSets()).toEqual([
      'set_gemini_idle_reap_minutes:{"geminiIdleReapMinutes":1440}',
      'set_gemini_idle_reap_minutes:{"geminiIdleReapMinutes":0}',
    ]);
    expect(input.value).toBe('0');
    expect(screen.getByText('Disabled')).toBeTruthy();
  });

  it('a blank or cleared edit commits nothing and restores the previous value', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(0);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    // Clearing a disabled (0) watchdog and clicking away must NOT silently
    // re-enable it via the default: the edit is abandoned, not confirmed.
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(commitSets()).toEqual([]);
    expect(input.value).toBe('0');
    expect(screen.getByText('Disabled')).toBeTruthy();
  });

  it('ignores malformed or negative echoes', () => {
    render(<GeminiIdleReapCard />);
    pushMinutes(30);
    expect(sentMessages()).toEqual(['get_gemini_idle_reap_minutes']);

    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    pushMinutes('not-json');
    pushMinutes(JSON.stringify({ geminiIdleReapMinutes: -5 }));
    expect(input.value).toBe('30');

    pushMinutes(60);
    expect(input.value).toBe('60');
  });
});
