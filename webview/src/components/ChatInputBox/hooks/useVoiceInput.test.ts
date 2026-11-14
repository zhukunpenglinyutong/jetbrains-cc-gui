import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertDictatedText, PUSH_TO_TALK_HOLD_MS, useVoiceInput } from './useVoiceInput';

function placeCaret(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('insertDictatedText', () => {
  let editable: HTMLDivElement;

  beforeEach(() => {
    editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.appendChild(editable);
    window.getSelection()?.removeAllRanges();
  });

  afterEach(() => {
    editable.remove();
  });

  it('fills an empty input without a leading space', () => {
    insertDictatedText(editable, 'hello');

    expect(editable.textContent).toBe('hello');
  });

  it('appends with a separating space when the caret is outside the input', () => {
    editable.textContent = 'fix the';

    insertDictatedText(editable, 'login bug');

    expect(editable.textContent).toBe('fix the login bug');
  });

  it('inserts at a collapsed caret inside the input', () => {
    editable.textContent = 'please  now';
    placeCaret(editable.firstChild!, 7);

    insertDictatedText(editable, 'refactor this');

    expect(editable.textContent).toBe('please refactor this now');
  });

  it('attaches sentence-closing punctuation without a space', () => {
    editable.textContent = 'generated asynchronously';

    insertDictatedText(editable, '. Also add a retry');

    expect(editable.textContent).toBe('generated asynchronously. Also add a retry');
  });

  it('drops the sentence closer when the sentence already ended or the box was cleared', () => {
    editable.textContent = 'Done.';
    insertDictatedText(editable, '. Next step');
    expect(editable.textContent).toBe('Done. Next step');

    editable.textContent = '';
    insertDictatedText(editable, '. Next step');
    expect(editable.textContent).toBe('Next step');
  });

  it('does not double the space after trailing whitespace', () => {
    editable.textContent = 'note: ';

    insertDictatedText(editable, 'done');

    expect(editable.textContent).toBe('note: done');
  });
});

describe('useVoiceInput', () => {
  let editable: HTMLDivElement;
  const sendToJava = vi.fn();

  beforeEach(() => {
    editable = document.createElement('div');
    document.body.appendChild(editable);
    sendToJava.mockReset();
    window.sendToJava = sendToJava;
  });

  afterEach(() => {
    editable.remove();
    delete window.sendToJava;
  });

  function render(overrides: Partial<Parameters<typeof useVoiceInput>[0]> = {}) {
    const options = {
      editableRef: { current: editable },
      getTextContent: () => editable.textContent ?? '',
      setHasContent: vi.fn(),
      onInput: vi.fn(),
      onError: vi.fn(),
      ...overrides,
    };
    return { options, hook: renderHook(() => useVoiceInput(options)) };
  }

  it('toggles start then stop and inserts the transcript', () => {
    const { options, hook } = render();

    act(() => hook.result.current.toggle());
    expect(sendToJava).toHaveBeenLastCalledWith('voice_input_start:');
    expect(hook.result.current.state).toBe('recording');

    act(() => hook.result.current.toggle());
    expect(sendToJava).toHaveBeenLastCalledWith('voice_input_stop:');
    expect(hook.result.current.state).toBe('transcribing');

    act(() => window.onVoiceInputUpdate?.(JSON.stringify({ state: 'idle', text: ' hello there ' })));

    expect(hook.result.current.state).toBe('idle');
    expect(editable.textContent).toBe('hello there');
    expect(options.setHasContent).toHaveBeenCalledWith(true);
    expect(options.onInput).toHaveBeenCalledWith('hello there');
  });

  it('ignores clicks while transcribing', () => {
    const { hook } = render();
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.toggle());
    sendToJava.mockClear();

    act(() => hook.result.current.toggle());

    expect(sendToJava).not.toHaveBeenCalled();
  });

  it('reports backend errors and returns to idle', () => {
    const { options, hook } = render();
    act(() => hook.result.current.toggle());

    act(() => window.onVoiceInputUpdate?.(JSON.stringify({
      state: 'idle',
      errorCode: 'mic_unavailable',
      error: 'no line',
    })));

    expect(hook.result.current.state).toBe('idle');
    expect(options.onError).toHaveBeenCalledWith('mic_unavailable', 'no line');
    expect(editable.textContent).toBe('');
  });

  it('appends live segments without leaving the recording state', () => {
    const { hook } = render();
    act(() => hook.result.current.toggle());

    act(() => window.onVoiceInputUpdate?.(JSON.stringify({ text: 'first phrase' })));
    act(() => window.onVoiceInputUpdate?.(JSON.stringify({ text: 'second phrase' })));

    expect(hook.result.current.state).toBe('recording');
    expect(editable.textContent).toBe('first phrase second phrase');
  });

  it('keeps recording on a mid-session error without a state change', () => {
    const { options, hook } = render();
    act(() => hook.result.current.toggle());

    act(() => window.onVoiceInputUpdate?.(JSON.stringify({ errorCode: 'transcription_failed', error: 'HTTP 500' })));

    expect(hook.result.current.state).toBe('recording');
    expect(options.onError).toHaveBeenCalledWith('transcription_failed', 'HTTP 500');
  });

  it('cancels an active recording on unmount', () => {
    const { hook } = render();
    act(() => hook.result.current.toggle());

    hook.unmount();

    expect(sendToJava).toHaveBeenLastCalledWith('voice_input_cancel:');
    expect(window.onVoiceInputUpdate).toBeUndefined();
  });
});

describe('voice shortcut (IDE keymap action)', () => {
  let editable: HTMLDivElement;
  const sendToJava = vi.fn();
  const shortcut = (phase: 'down' | 'up') => act(() => window.voiceInputShortcut?.(phase));
  const voiceCalls = () => sendToJava.mock.calls
    .map((call) => call[0] as string)
    .filter((message) => message === 'voice_input_start:' || message === 'voice_input_stop:');

  beforeEach(() => {
    vi.useFakeTimers();
    editable = document.createElement('div');
    document.body.appendChild(editable);
    sendToJava.mockReset();
    window.sendToJava = sendToJava;
  });

  afterEach(() => {
    vi.useRealTimers();
    editable.remove();
    delete window.sendToJava;
  });

  function render() {
    return renderHook(() => useVoiceInput({
      editableRef: { current: editable },
      getTextContent: () => editable.textContent ?? '',
      setHasContent: vi.fn(),
    }));
  }

  it('asks Java for the keymap binding and exposes it', () => {
    const hook = render();
    expect(sendToJava).toHaveBeenCalledWith('voice_input_attach:');

    act(() => window.onVoiceInputUpdate?.(JSON.stringify({ shortcut: 'Ctrl+Shift+.' })));

    expect(hook.result.current.shortcut).toBe('Ctrl+Shift+.');
    expect(hook.result.current.state).toBe('idle');
  });

  it('holding the shortcut records until release', () => {
    const hook = render();

    shortcut('down');
    expect(voiceCalls()).toEqual(['voice_input_start:']);
    vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS + 100);
    shortcut('up');

    expect(voiceCalls()).toEqual(['voice_input_start:', 'voice_input_stop:']);
    expect(hook.result.current.state).toBe('transcribing');
  });

  it('a quick tap toggles: first tap starts, second tap stops', () => {
    const hook = render();

    shortcut('down');
    vi.advanceTimersByTime(100);
    shortcut('up');
    expect(hook.result.current.state).toBe('recording');

    vi.advanceTimersByTime(3000);
    shortcut('down');
    vi.advanceTimersByTime(100);
    shortcut('up');

    expect(voiceCalls()).toEqual(['voice_input_start:', 'voice_input_stop:']);
    expect(hook.result.current.state).toBe('transcribing');
  });

  it('ignores the shortcut while the previous clip is still transcribing', () => {
    const hook = render();
    shortcut('down');
    shortcut('up');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('transcribing');

    shortcut('down');
    shortcut('up');

    expect(voiceCalls()).toEqual(['voice_input_start:', 'voice_input_stop:']);
  });

  it('escape cancels a recording', () => {
    const hook = render();
    shortcut('down');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(sendToJava).toHaveBeenLastCalledWith('voice_input_cancel:');
    expect(hook.result.current.state).toBe('idle');
  });

  it('escape also cancels while the clip is still transcribing', () => {
    const hook = render();
    shortcut('down');
    shortcut('up');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('transcribing');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(sendToJava).toHaveBeenLastCalledWith('voice_input_cancel:');
    expect(hook.result.current.state).toBe('idle');
  });

  it('escape inside a dialog is left to the dialog', () => {
    const hook = render();
    shortcut('down');
    const dialogInput = document.createElement('input');
    document.body.appendChild(dialogInput);

    act(() => {
      dialogInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(hook.result.current.state).toBe('recording');
    dialogInput.remove();
  });

  it('escape is left alone when not recording', () => {
    render();
    sendToJava.mockClear();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(sendToJava).not.toHaveBeenCalled();
  });

  it('unregisters the shortcut bridge on unmount', () => {
    const hook = render();

    hook.unmount();

    expect(window.voiceInputShortcut).toBeUndefined();
  });
});
