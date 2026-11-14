import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VoiceInputSection, { endpointProblem, type VoiceInputSettings } from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const value = params?.hint ?? params?.ms ?? params?.error;
      return value === undefined ? key : `${key}:${String(value)}`;
    },
  }),
}));

const SAVED: VoiceInputSettings = {
  baseUrl: 'https://stt.example.com/v1',
  model: 'whisper-1',
  language: '',
  liveTranscription: false,
  fillerWords: 'uh, um',
  apiKeySet: true,
  apiKeyHint: '…abcd',
  shortcut: 'Ctrl+Alt+Shift+M',
};

describe('endpointProblem', () => {
  it('matches the Java rules, including the cases browsers normalize', () => {
    expect(endpointProblem('http://127.1/v1')).toBe('invalid_endpoint');
    expect(endpointProblem('http://[0:0:0:0:0:0:0:1]/v1')).toBe('insecure_endpoint');
    expect(endpointProblem('https://my_host/v1')).toBe('invalid_endpoint');
    expect(endpointProblem('https:stt.example.com')).toBe('invalid_endpoint');
    expect(endpointProblem('https://stt.example.com/v1?key=1')).toBe('invalid_endpoint');
    expect(endpointProblem('HTTPS://STT.EXAMPLE.COM/v1/ ')).toBeNull();
    expect(endpointProblem('http://LOCALHOST:8080')).toBeNull();
  });

  it('accepts https anywhere and http only on this machine', () => {
    expect(endpointProblem('')).toBeNull();
    expect(endpointProblem('https://stt.example.com/v1')).toBeNull();
    expect(endpointProblem('http://localhost:8080/v1')).toBeNull();
    expect(endpointProblem('http://127.0.0.1:9000')).toBeNull();
    expect(endpointProblem('http://[::1]:9000')).toBeNull();
    expect(endpointProblem('http://stt.example.com/v1')).toBe('insecure_endpoint');
    expect(endpointProblem('stt.example.com/v1')).toBe('invalid_endpoint');
    expect(endpointProblem('ftp://stt.example.com')).toBe('invalid_endpoint');
  });
});

describe('VoiceInputSection', () => {
  const sendToJava = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    sendToJava.mockReset();
    window.sendToJava = sendToJava;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.sendToJava;
  });

  /** Parsed messages of one type, with Java's requestId kept aside. */
  const sent = (type: string) => sendToJava.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.startsWith(`${type}:`))
    .map((message) => JSON.parse(message.slice(type.length + 1)) as Record<string, unknown>);
  const reply = (payload: unknown, requestId?: number) =>
    act(() => window.updateVoiceInputConfig?.(JSON.stringify(requestId === undefined ? payload : { ...(payload as object), requestId })));
  /** Answers the most recent save the way Java does: echo the stored settings with its id. */
  const replyToSave = (payload: unknown, index = -1) => reply(payload, sent('voice_input_set_config').at(index)?.requestId as number);

  function renderLoaded(settings: VoiceInputSettings = SAVED) {
    const view = render(<VoiceInputSection />);
    reply(settings);
    return view;
  }

  function lastMessage(type: string): Record<string, unknown> {
    const message = sendToJava.mock.calls.at(-1)?.[0] as string;
    expect(message.startsWith(`${type}:`)).toBe(true);
    const { requestId: _ignored, ...body } = JSON.parse(message.slice(type.length + 1));
    return body;
  }
  const lastUpdate = () => lastMessage('voice_input_set_config');
  const input = (label: string) => screen.getByLabelText(`settings.voiceInput.${label}.label`) as HTMLInputElement;
  const switches = () => screen.getAllByRole('switch') as HTMLButtonElement[];
  const saveCalls = () => sendToJava.mock.calls.filter((call) => String(call[0]).startsWith('voice_input_set_config:'));

  it('loads the config without the key and shows the shortcut as key caps', () => {
    renderLoaded();

    expect(sent('voice_input_get_config')).toEqual([{ requestId: 1 }]);
    expect(input('baseUrl').value).toBe('https://stt.example.com/v1');
    expect(input('apiKey').placeholder).toBe('settings.voiceInput.apiKey.placeholderSaved:…abcd');
    expect(screen.getByTestId('voice-input-shortcut').textContent).toBe('Ctrl+Alt+Shift+M');
    expect(screen.getByTestId('voice-input-shortcut').querySelectorAll('kbd')).toHaveLength(4);
    expect(screen.queryByTestId('voice-input-load-state')).toBeNull();
    expect(switches().map((s) => s.getAttribute('aria-checked'))).toEqual(['false']);
    expect(input('fillers').value).toBe('uh, um');
  });

  it('shows no key and unassigned shortcut states', () => {
    renderLoaded({ ...SAVED, apiKeySet: false, apiKeyHint: '', shortcut: '' });

    expect(input('apiKey').placeholder).toBe('settings.voiceInput.apiKey.placeholderNone');
    expect(screen.queryByText('settings.voiceInput.apiKey.clear')).toBeNull();
    expect(screen.getByTestId('voice-input-shortcut').textContent).toBe('settings.voiceInput.shortcut.unbound');
  });

  it('flags an insecure endpoint while typing', () => {
    renderLoaded();

    fireEvent.change(input('baseUrl'), { target: { value: 'http://stt.example.com/v1' } });

    expect(input('baseUrl').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('voiceInput.error.insecure_endpoint')).toBeTruthy();
  });

  it('retries a lost config request, then offers a retry button instead of blank fields', () => {
    render(<VoiceInputSection />);
    expect(screen.getByTestId('voice-input-load-state').textContent).toContain('settings.voiceInput.loading');
    expect(input('baseUrl').disabled).toBe(true);

    act(() => vi.advanceTimersByTime(3000));
    expect(sent('voice_input_get_config')).toHaveLength(2);

    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId('voice-input-load-state').textContent)
      .toContain('settings.voiceInput.loadFailed:settings.voiceInput.noResponse');

    fireEvent.click(screen.getByText('settings.voiceInput.retry'));
    reply(SAVED);
    expect(screen.queryByTestId('voice-input-load-state')).toBeNull();
    expect(input('model').value).toBe('whisper-1');
  });

  it('shows the reason when Java cannot read the config', () => {
    render(<VoiceInputSection />);

    reply({ error: 'config.json is malformed' });

    expect(screen.getByTestId('voice-input-load-state').textContent)
      .toContain('settings.voiceInput.loadFailed:config.json is malformed');
  });

  it('auto-saves a text field on blur, only when it changed', () => {
    renderLoaded();

    fireEvent.blur(input('model'));
    expect(saveCalls()).toHaveLength(0);

    fireEvent.change(input('model'), { target: { value: ' whisper-large-v3 ' } });
    fireEvent.blur(input('model'));
    expect(lastUpdate()).toEqual({ model: 'whisper-large-v3' });

    replyToSave({ ...SAVED, model: 'whisper-large-v3' });
    expect(screen.getByTestId('voice-input-save-status').textContent).toContain('settings.voiceInput.savedInline');
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByTestId('voice-input-save-status')).toBeNull();
  });

  it('enter commits the field, and the blur that follows does not save it again', () => {
    renderLoaded();
    const field = input('language');
    fireEvent.change(field, { target: { value: 'uk' } });

    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);

    expect(lastUpdate()).toEqual({ language: 'uk' });
    expect(saveCalls()).toHaveLength(1);
  });

  it('matches overlapping saves to their replies without losing typing or flipping switches back', () => {
    renderLoaded();
    fireEvent.change(input('apiKey'), { target: { value: 'sk-half-typed' } });

    // Blur the endpoint by clicking a switch: two saves in flight.
    fireEvent.change(input('baseUrl'), { target: { value: 'https://other.example.com/v1' } });
    fireEvent.blur(input('baseUrl'));
    fireEvent.click(switches()[0]);
    expect(saveCalls()).toHaveLength(2);

    replyToSave({ ...SAVED, baseUrl: 'https://other.example.com/v1' }, 0);
    expect(switches()[0].getAttribute('aria-checked')).toBe('true');
    expect(input('apiKey').value).toBe('sk-half-typed');
    expect(input('baseUrl').value).toBe('https://other.example.com/v1');

    replyToSave({ ...SAVED, baseUrl: 'https://other.example.com/v1', liveTranscription: true }, 1);
    expect(switches()[0].getAttribute('aria-checked')).toBe('true');
    expect(input('apiKey').value).toBe('sk-half-typed');
  });

  it('keeps unsaved typing in other fields when one field saves', () => {
    renderLoaded();
    fireEvent.change(input('baseUrl'), { target: { value: 'https://typing.example/v1' } });

    fireEvent.change(input('model'), { target: { value: 'other-model' } });
    fireEvent.blur(input('model'));
    replyToSave({ ...SAVED, model: 'other-model' });

    expect(input('baseUrl').value).toBe('https://typing.example/v1');
    expect(input('model').value).toBe('other-model');
  });

  it('saves a typed key on blur and clears the field after the echo', () => {
    renderLoaded();
    fireEvent.blur(input('apiKey'));
    expect(saveCalls()).toHaveLength(0);

    fireEvent.change(input('apiKey'), { target: { value: ' sk-new ' } });
    fireEvent.blur(input('apiKey'));
    expect(lastUpdate()).toEqual({ apiKey: 'sk-new' });

    replyToSave({ ...SAVED, apiKeyHint: '…-new' });
    expect(input('apiKey').value).toBe('');
    expect(input('apiKey').placeholder).toBe('settings.voiceInput.apiKey.placeholderSaved:…-new');
  });

  it('applies switches immediately and keeps them keyboard-operable', () => {
    renderLoaded();
    const [live] = switches();

    fireEvent.click(live);
    expect(lastUpdate()).toEqual({ liveTranscription: true });
    expect(live.getAttribute('aria-checked')).toBe('true');
    expect(live.tagName).toBe('BUTTON');
  });

  it('reports a failed save and lets the same value be retried', () => {
    renderLoaded();
    fireEvent.change(input('model'), { target: { value: 'x' } });
    fireEvent.blur(input('model'));

    replyToSave({ error: 'disk full' });
    expect(screen.getByTestId('voice-input-save-status').textContent).toBe('settings.voiceInput.saveFailed:disk full');
    expect(input('model').value).toBe('x');

    fireEvent.blur(input('model'));
    expect(saveCalls()).toHaveLength(2);
  });

  it('a late duplicate load reply does not wipe what the user typed', () => {
    render(<VoiceInputSection />);
    act(() => vi.advanceTimersByTime(3000));
    const [first, retry] = sent('voice_input_get_config');
    reply(SAVED, first.requestId as number);
    fireEvent.change(input('model'), { target: { value: 'typing' } });

    reply(SAVED, retry.requestId as number);

    expect(input('model').value).toBe('typing');
  });

  it('a switch whose save fails shows its stored value again', () => {
    renderLoaded();
    fireEvent.click(switches()[0]);
    expect(switches()[0].getAttribute('aria-checked')).toBe('true');

    replyToSave({ error: 'disk full' });

    expect(switches()[0].getAttribute('aria-checked')).toBe('false');
  });

  it('sends nothing and queues nothing without the Java bridge', () => {
    delete window.sendToJava;
    render(<VoiceInputSection />);
    window.sendToJava = sendToJava;
    act(() => vi.advanceTimersByTime(3000));

    expect(sent('voice_input_get_config')).toEqual([{ requestId: 1 }]);
  });

  it('auto-saves the filler words and shows them as Java normalised them', () => {
    renderLoaded();

    fireEvent.change(input('fillers'), { target: { value: 'uh,um ,эм' } });
    fireEvent.blur(input('fillers'));
    expect(lastUpdate()).toEqual({ fillerWords: 'uh,um ,эм' });

    replyToSave({ ...SAVED, fillerWords: 'uh, um, эм' });
    expect(input('fillers').value).toBe('uh, um, эм');
  });

  it('removes a stored key', () => {
    renderLoaded();

    fireEvent.click(screen.getByText('settings.voiceInput.apiKey.clear'));

    expect(lastUpdate()).toEqual({ apiKey: '' });
  });

  it('tests the unsaved form and reports the outcome', () => {
    renderLoaded();
    fireEvent.change(input('model'), { target: { value: 'gpt-live-1' } });

    fireEvent.click(screen.getByText('settings.voiceInput.test.button'));
    expect(lastMessage('voice_input_test_config')).toEqual({
      baseUrl: 'https://stt.example.com/v1',
      model: 'gpt-live-1',
      language: '',
    });
    expect(screen.getByTestId('voice-input-test-status').textContent).toBe('settings.voiceInput.test.testing');

    act(() => window.onVoiceInputTestResult?.(JSON.stringify({ ok: false, error: 'HTTP 400: unsupported model: gpt-live-1' })));
    expect(screen.getByTestId('voice-input-test-status').textContent)
      .toBe('settings.voiceInput.test.failed:HTTP 400: unsupported model: gpt-live-1');

    fireEvent.click(screen.getByText('settings.voiceInput.test.button'));
    act(() => window.onVoiceInputTestResult?.(JSON.stringify({ ok: false, errorCode: 'missing_model' })));
    expect(screen.getByTestId('voice-input-test-status').textContent).toBe('voiceInput.error.missing_model');

    fireEvent.click(screen.getByText('settings.voiceInput.test.button'));
    act(() => window.onVoiceInputTestResult?.(JSON.stringify({ ok: true, latencyMs: 540 })));
    expect(screen.getByTestId('voice-input-test-status').textContent).toBe('settings.voiceInput.test.ok:540');
  });

  it('an older unmount does not remove a newer mount\'s callbacks', () => {
    const first = render(<VoiceInputSection />);
    render(<VoiceInputSection />);

    first.unmount();

    expect(typeof window.updateVoiceInputConfig).toBe('function');
    expect(typeof window.onVoiceInputTestResult).toBe('function');
  });
});
