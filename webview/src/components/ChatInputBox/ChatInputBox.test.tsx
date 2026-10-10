import { createRef, StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInputBox } from './ChatInputBox.js';
import type { ChatInputBoxHandle, ChatInputBoxProps } from './types.js';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../contexts/UIStateContext.js', () => ({
  useUIState: () => ({ setSettingsInitialTab: vi.fn(), setCurrentView: vi.fn() }),
}));

vi.mock('./ChatInputBoxHeader.js', () => ({ ChatInputBoxHeader: () => null }));
vi.mock('./ChatInputBoxFooter.js', () => ({ ChatInputBoxFooter: () => null }));

function typeText(editable: HTMLElement, text: string) {
  editable.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.input(editable, { inputType: 'insertText' });
}

function ControlledInput({ visible = true, ...props }: ChatInputBoxProps & { visible?: boolean }) {
  const [value, setValue] = useState('');
  return visible ? <ChatInputBox {...props} value={value} onInput={setValue} /> : null;
}

describe('ChatInputBox event wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    delete window.sendToJava;
    vi.useRealTimers();
  });

  it.each(['imperative', 'controlled', 'clear'] as const)(
    'cancels native image ownership when the draft is replaced through %s',
    async (mode) => {
      const sendToJava = vi.fn();
      window.sendToJava = sendToJava;
      const ref = createRef<ChatInputBoxHandle>();
      const onSubmit = vi.fn();
      const { rerender } = render(<ChatInputBox ref={ref} onSubmit={onSubmit} />);
      const editable = screen.getByRole('textbox');
      typeText(editable, 'old draft');
      act(() => window.dispatchEvent(new CustomEvent('java-request-paste-image')));
      const request = sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image:'))?.[0] as string;
      expect(request).toMatch(/^paste_image:.+/);
      if (mode === 'imperative') {
        act(() => ref.current?.setValue('replacement'));
      } else if (mode === 'clear') {
        act(() => ref.current?.clear());
        typeText(editable, 'replacement');
      } else {
        act(() => editable.blur());
        rerender(<ChatInputBox ref={ref} onSubmit={onSubmit} value="replacement" />);
      }
      await act(async () => window.dispatchEvent(new CustomEvent('java-paste-image', {
        detail: { requestId: request.slice('paste_image:'.length), base64: 'STALE', mediaType: 'image/png' },
      })));
      fireEvent.keyDown(editable, { key: 'Enter', code: 'Enter' });
      fireEvent.keyUp(editable, { key: 'Enter', code: 'Enter' });
      await act(() => vi.advanceTimersByTimeAsync(20));
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('replacement', undefined);
    },
  );

  it('preserves a pending draft when navigating away and back before debounce', async () => {
    const { rerender } = render(<ControlledInput />);
    typeText(screen.getByRole('textbox'), 'keep my latest characters');

    rerender(<ControlledInput visible={false} />);
    await act(() => vi.advanceTimersByTimeAsync(200));
    await act(async () => rerender(<ControlledInput />));

    expect(screen.getByRole('textbox').textContent).toBe('keep my latest characters');
  });

  it.each([0, 75])('preserves committed IME text when leaving %ims after compositionend', async (delay) => {
    const { rerender } = render(<ControlledInput />);
    const editable = screen.getByRole('textbox');
    typeText(editable, 'draft ');
    await act(() => vi.advanceTimersByTimeAsync(50));
    fireEvent.compositionStart(editable);
    editable.textContent = 'draft 确认';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    fireEvent.compositionEnd(editable, { data: '确认' });
    await act(() => vi.advanceTimersByTimeAsync(delay));

    rerender(<ControlledInput visible={false} />);
    await act(() => vi.advanceTimersByTimeAsync(200));
    await act(async () => rerender(<ControlledInput />));

    expect(screen.getByRole('textbox').textContent).toBe('draft 确认');
  });

  it('does not publish a queued draft while IME composition is active', async () => {
    const onInput = vi.fn();
    render(<ChatInputBox onInput={onInput} />);
    const editable = screen.getByRole('textbox');
    typeText(editable, 'draft ');
    await act(() => vi.advanceTimersByTimeAsync(50));
    fireEvent.compositionStart(editable);
    editable.textContent = 'draft 确';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(onInput).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editable, { data: '确' });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onInput).toHaveBeenCalledExactlyOnceWith('draft 确');
  });

  it('preserves unsynced composition text if the editor unmounts before compositionend', async () => {
    const { rerender } = render(<ControlledInput />);
    const editable = screen.getByRole('textbox');
    fireEvent.compositionStart(editable);
    editable.textContent = '输入中';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });

    rerender(<ControlledInput visible={false} />);
    await act(() => vi.advanceTimersByTimeAsync(200));
    await act(async () => rerender(<ControlledInput />));

    expect(screen.getByRole('textbox').textContent).toBe('输入中');
  });

  it('does not publish hydrated values during StrictMode cleanup or unmount', () => {
    const onInput = vi.fn();
    const { unmount } = render(
      <StrictMode><ChatInputBox value="restored draft" onInput={onInput} /></StrictMode>,
    );

    unmount();

    expect(onInput).not.toHaveBeenCalled();
  });

  it('does not publish a superseded draft after imperative replacement and unmount', async () => {
    const ref = createRef<ChatInputBoxHandle>();
    const onInput = vi.fn();
    const { unmount } = render(<ChatInputBox ref={ref} onInput={onInput} />);
    typeText(screen.getByRole('textbox'), 'old draft');

    act(() => ref.current?.setValue('replacement'));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(onInput).not.toHaveBeenCalled();
  });

  it.each(['imperative', 'controlled'] as const)(
    'does not publish a %s replacement through a pending composition fallback',
    async (mode) => {
      const ref = createRef<ChatInputBoxHandle>();
      const onInput = vi.fn();
      const { rerender } = render(<ChatInputBox ref={ref} onInput={onInput} />);
      const editable = screen.getByRole('textbox');
      fireEvent.compositionStart(editable);
      editable.textContent = '旧草稿';
      fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
      fireEvent.compositionEnd(editable, { data: '旧草稿' });

      if (mode === 'imperative') {
        act(() => ref.current?.setValue('replacement'));
      } else {
        act(() => editable.blur());
        rerender(<ChatInputBox ref={ref} onInput={onInput} value="replacement" />);
      }
      await act(() => vi.advanceTimersByTimeAsync(300));

      expect(editable.textContent).toBe('replacement');
      expect(onInput).not.toHaveBeenCalled();
    },
  );

  it('does not notify a cleared draft again through a pending composition fallback', async () => {
    const ref = createRef<ChatInputBoxHandle>();
    const onInput = vi.fn();
    render(<ChatInputBox ref={ref} onInput={onInput} />);
    const editable = screen.getByRole('textbox');
    fireEvent.compositionStart(editable);
    editable.textContent = '旧草稿';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    fireEvent.compositionEnd(editable, { data: '旧草稿' });

    act(() => ref.current?.clear());
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(editable.textContent).toBe('');
    expect(onInput).toHaveBeenCalledExactlyOnceWith('');
  });

  it('does not let a pending draft overwrite an IDE snippet insertion', async () => {
    const onInput = vi.fn();
    render(<ChatInputBox onInput={onInput} />);
    typeText(screen.getByRole('textbox'), 'draft ');

    act(() => window.insertCodeSnippetAtCursor?.('snippet'));
    expect(onInput).toHaveBeenLastCalledWith('draft snippet ');
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(onInput).toHaveBeenCalledExactlyOnceWith('draft snippet ');
  });

  it('does not restore a cleared draft when the input unmounts', async () => {
    const ref = createRef<ChatInputBoxHandle>();
    const onInput = vi.fn();
    const { unmount } = render(<ChatInputBox ref={ref} onInput={onInput} />);
    typeText(screen.getByRole('textbox'), 'discard this draft');

    act(() => ref.current?.clear());
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(onInput).toHaveBeenCalledExactlyOnceWith('');
  });

  it('submits once with native capture and React handlers both installed', async () => {
    const onSubmit = vi.fn();
    render(<ControlledInput onSubmit={onSubmit} />);
    const editable = screen.getByRole('textbox');
    fireEvent.focus(editable);
    typeText(editable, 'send this');

    expect(fireEvent.keyDown(editable, { key: 'Enter', code: 'Enter' })).toBe(false);
    fireEvent.keyUp(editable, { key: 'Enter', code: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('send this', undefined);
    expect(editable.textContent).toBe('');
  });

  it('forwards IDE shortcut submissions while loading so the parent can queue them', async () => {
    const onSubmit = vi.fn();
    render(<ControlledInput isLoading onSubmit={onSubmit} />);
    const editable = screen.getByRole('textbox');
    typeText(editable, 'send after the current response');

    act(() => document.dispatchEvent(new CustomEvent('ideaSend')));
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('send after the current response', undefined);
    expect(editable.textContent).toBe('');
  });

  it('uses the latest submit callback for IDE shortcuts and waits for IME confirmation', async () => {
    const previousSubmit = vi.fn();
    const nextSubmit = vi.fn();
    const { rerender } = render(<ControlledInput onSubmit={previousSubmit} />);
    const editable = screen.getByRole('textbox');
    fireEvent.compositionStart(editable);
    editable.textContent = '确认';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    rerender(<ControlledInput onSubmit={nextSubmit} />);

    act(() => document.dispatchEvent(new CustomEvent('ideaSend')));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(nextSubmit).not.toHaveBeenCalled();
    expect(editable.textContent).toBe('确认');

    fireEvent.compositionEnd(editable, { data: '确认' });
    act(() => document.dispatchEvent(new CustomEvent('ideaSend')));
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(previousSubmit).not.toHaveBeenCalled();
    expect(nextSubmit).toHaveBeenCalledExactlyOnceWith('确认', undefined);
  });

  it('keeps typing immediately after an imperative value update', async () => {
    const ref = createRef<ChatInputBoxHandle>();
    const onInput = vi.fn();
    render(<ChatInputBox ref={ref} onInput={onInput} />);
    const editable = screen.getByRole('textbox');

    act(() => ref.current?.setValue('draft'));
    typeText(editable, 'draft continued');
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(onInput).toHaveBeenLastCalledWith('draft continued');
    expect(ref.current?.getValue()).toBe('draft continued');
  });

  it('respects the modified Enter shortcut without submitting plain Enter', async () => {
    const onSubmit = vi.fn();
    render(<ControlledInput sendShortcut="cmdEnter" onSubmit={onSubmit} />);
    const editable = screen.getByRole('textbox');
    typeText(editable, 'multiline draft');

    expect(fireEvent.keyDown(editable, { key: 'Enter', code: 'Enter' })).toBe(true);
    fireEvent.keyUp(editable, { key: 'Enter', code: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onSubmit).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(editable, { key: 'Enter', code: 'Enter', ctrlKey: true })).toBe(false);
    fireEvent.keyUp(editable, { key: 'Enter', code: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('multiline draft', undefined);
  });

  it.each(['enter', 'cmdEnter'] as const)(
    'keeps a held IME confirmation from becoming another action in %s mode',
    async (sendShortcut) => {
      const onSubmit = vi.fn();
      render(<ControlledInput sendShortcut={sendShortcut} onSubmit={onSubmit} />);
      const editable = screen.getByRole('textbox');

      fireEvent.compositionStart(editable);
      editable.textContent = '确认';
      fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
      expect(fireEvent.keyDown(editable, { key: 'Enter', isComposing: true })).toBe(true);
      fireEvent.compositionEnd(editable, { data: '确认' });
      await act(() => vi.advanceTimersByTimeAsync(150));

      expect(fireEvent.keyDown(editable, { key: 'Enter', repeat: true })).toBe(false);
      expect(fireEvent(editable, new InputEvent('beforeinput', {
        inputType: 'insertParagraph', bubbles: true, cancelable: true,
      }))).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(editable.textContent).toBe('确认');

      fireEvent.keyUp(editable, { key: 'Enter' });
      fireEvent.keyDown(editable, { key: 'Enter', ctrlKey: sendShortcut === 'cmdEnter' });
      fireEvent.keyUp(editable, { key: 'Enter' });
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('确认', undefined);
    },
  );

  it.each([
    { sendShortcut: 'enter' as const, withKeyDown: false },
    { sendShortcut: 'enter' as const, withKeyDown: true },
    { sendShortcut: 'cmdEnter' as const, withKeyDown: false },
    { sendShortcut: 'cmdEnter' as const, withKeyDown: true },
  ])(
    'recovers a lost compositionend from a non-composing paragraph in $sendShortcut mode (keydown: $withKeyDown)',
    async ({ sendShortcut, withKeyDown }) => {
      const onInput = vi.fn();
      const onSubmit = vi.fn();
      render(<ChatInputBox sendShortcut={sendShortcut} onInput={onInput} onSubmit={onSubmit} />);
      const editable = screen.getByRole('textbox');

      fireEvent.compositionStart(editable);
      editable.textContent = '确认';
      fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
      if (withKeyDown) fireEvent.keyDown(editable, { key: 'Enter', isComposing: false });
      expect(fireEvent(editable, new InputEvent('beforeinput', {
        inputType: 'insertParagraph', bubbles: true, cancelable: true,
      }))).toBe(false);
      if (withKeyDown) fireEvent.keyUp(editable, { key: 'Enter' });
      await act(() => vi.advanceTimersByTimeAsync(250));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(onInput).toHaveBeenCalledExactlyOnceWith('确认');
      expect(editable.textContent).toBe('确认');

      fireEvent.keyDown(editable, { key: 'Enter', ctrlKey: sendShortcut === 'cmdEnter' });
      fireEvent.keyUp(editable, { key: 'Enter' });
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('确认', undefined);
    },
  );

  it('keeps composition active when an IME-owned Enter emits a paragraph', async () => {
    const onInput = vi.fn();
    const onSubmit = vi.fn();
    render(<ChatInputBox onInput={onInput} onSubmit={onSubmit} />);
    const editable = screen.getByRole('textbox');

    fireEvent.compositionStart(editable);
    editable.textContent = '中';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    fireEvent.keyDown(editable, { key: 'Enter', isComposing: true });
    fireEvent(editable, new InputEvent('beforeinput', {
      inputType: 'insertParagraph', bubbles: true, cancelable: true,
    }));
    fireEvent.keyUp(editable, { key: 'Enter', isComposing: true });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(onInput).not.toHaveBeenCalled();

    fireEvent.keyDown(editable, { key: 'Enter', isComposing: true });
    fireEvent.keyUp(editable, { key: 'Enter', isComposing: true });
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionUpdate(editable, { data: '中文' });
    editable.textContent = '中文';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent.keyDown(editable, { key: 'Enter', isComposing: true });
    fireEvent.keyUp(editable, { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(20));

    expect(onInput).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editable.textContent).toBe('中文');

    fireEvent.compositionEnd(editable, { data: '中文' });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(onInput).toHaveBeenCalledExactlyOnceWith('中文');
    fireEvent.keyDown(editable, { key: 'Enter' });
    fireEvent.keyUp(editable, { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('中文', undefined);
  });

  it('does not publish recovered text during a new composition', async () => {
    const onInput = vi.fn();
    const onSubmit = vi.fn();
    render(<ChatInputBox onInput={onInput} onSubmit={onSubmit} />);
    const editable = screen.getByRole('textbox');

    fireEvent.compositionStart(editable);
    editable.textContent = '确';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    fireEvent.keyDown(editable, { key: 'Enter', isComposing: true });
    expect(fireEvent(editable, new InputEvent('beforeinput', {
      inputType: 'insertParagraph', isComposing: true, bubbles: true, cancelable: true,
    }))).toBe(false);
    fireEvent.keyUp(editable, { key: 'Enter' });

    fireEvent.compositionStart(editable);
    editable.textContent = '确认';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(onInput).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(editable, { data: '认' });
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onInput).toHaveBeenCalledExactlyOnceWith('确认');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps IME confirmation separate from the next explicit send', async () => {
    const onSubmit = vi.fn();
    render(<ControlledInput onSubmit={onSubmit} />);
    const editable = screen.getByRole('textbox');

    fireEvent.compositionStart(editable);
    editable.textContent = '你好';
    fireEvent.input(editable, { inputType: 'insertCompositionText', isComposing: true });
    fireEvent.keyDown(editable, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(editable, { data: '你好' });
    fireEvent.keyUp(editable, { key: 'Enter', code: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(editable.textContent).toBe('你好');

    fireEvent.keyDown(editable, { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(editable, { key: 'Enter', code: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('你好', undefined);
  });
});
