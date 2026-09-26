import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement, Suspense, startTransition, useRef, useState } from 'react';
import type React from 'react';
import { useKeyboardHandler } from './useKeyboardHandler.js';
import type { UseKeyboardHandlerOptions } from './useKeyboardHandler.js';
import { useNativeEventCapture } from './useNativeEventCapture.js';

function mountKeyboard(options: {
  sendShortcut?: 'enter' | 'cmdEnter';
  completionOpen?: boolean;
  recentlyComposing?: boolean;
} = {}) {
  const handleSubmit = vi.fn();
  const handleSelect = vi.fn();
  let shared: UseKeyboardHandlerOptions;

  function Fixture() {
    const editableRef = useRef<HTMLDivElement>(null);
    const [completionOpen, setCompletionOpen] = useState(options.completionOpen ?? false);
    const closed = { isOpen: false, handleKeyDown: () => false };
    shared = {
      isComposingRef: useRef(false),
      lastCompositionEndTimeRef: useRef(Date.now() - (options.recentlyComposing ? 0 : 1000)),
      completionSelectedRef: useRef(false),
      submittedOnEnterRef: useRef(false),
      sendShortcut: options.sendShortcut ?? 'enter',
      fileCompletion: {
        isOpen: completionOpen,
        handleKeyDown: (event) => {
          if (event.key !== 'Enter') return false;
          handleSelect();
          setCompletionOpen(false);
          return true;
        },
      },
      commandCompletion: closed,
      agentCompletion: closed,
      promptCompletion: closed,
      dollarCommandCompletion: closed,
      handleMacCursorMovement: () => false,
      handleHistoryKeyDown: () => false,
      handleSubmit,
    };
    const { onKeyDown, onKeyUp } = useKeyboardHandler(shared);
    useNativeEventCapture({
      ...shared,
      editableRef,
      handleEnhancePrompt: () => {},
      handleCompositionEnd: () => {},
    });
    return createElement('div', { ref: editableRef, tabIndex: 0, onKeyDown, onKeyUp });
  }

  const view = render(createElement(Fixture));
  return {
    el: view.container.firstElementChild as HTMLDivElement,
    handleSubmit,
    handleSelect,
    get state() { return shared; },
  };
}

function dispatchEnter(el: EventTarget, type: 'keydown' | 'keyup', options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => { el.dispatchEvent(event); });
  return event;
}

function createBeforeInputEvent(inputType: string, isComposing = false): InputEvent {
  const event = new Event('beforeinput', {
    bubbles: true,
    cancelable: true,
  }) as InputEvent;
  Object.defineProperty(event, 'inputType', { value: inputType });
  Object.defineProperty(event, 'isComposing', { value: isComposing });
  return event;
}

describe('useNativeEventCapture', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('allows two independent beforeinput-only submissions', () => {
    const fixture = mountKeyboard();
    act(() => { fixture.el.dispatchEvent(createBeforeInputEvent('insertParagraph')); });
    act(() => { fixture.el.dispatchEvent(createBeforeInputEvent('insertParagraph')); });

    expect(fixture.handleSubmit).toHaveBeenCalledTimes(2);
    expect(fixture.state.submittedOnEnterRef.current).toBe(false);
  });

  it('releases the press on blur so a keydown-less paragraph can send again', () => {
    const fixture = mountKeyboard();
    fixture.el.focus();
    dispatchEnter(fixture.el, 'keydown');
    expect(fixture.state.submittedOnEnterRef.current).toBe(true);

    act(() => { fixture.el.blur(); });
    dispatchEnter(document.body, 'keyup');
    expect(fixture.state.submittedOnEnterRef.current).toBe(false);

    act(() => { fixture.el.dispatchEvent(createBeforeInputEvent('insertParagraph')); });
    expect(fixture.handleSubmit).toHaveBeenCalledTimes(2);
  });

  it('recovers a fresh Enter when no keyup or blur was delivered', () => {
    const fixture = mountKeyboard();
    dispatchEnter(fixture.el, 'keydown');
    dispatchEnter(fixture.el, 'keydown');
    expect(fixture.handleSubmit).toHaveBeenCalledTimes(2);
  });

  it('claims Enter without hiding it from document-level listeners', () => {
    const fixture = mountKeyboard();
    const seenAtDocument = vi.fn((ev: KeyboardEvent) => ev.defaultPrevented);
    document.addEventListener('keydown', seenAtDocument);
    try {
      dispatchEnter(fixture.el, 'keydown');
    } finally {
      document.removeEventListener('keydown', seenAtDocument);
    }

    expect(fixture.handleSubmit).toHaveBeenCalledTimes(1);
    expect(seenAtDocument).toHaveReturnedWith(true);
  });

  it.each([
    { sendShortcut: 'enter' as const, metaKey: false, ctrlKey: false },
    { sendShortcut: 'cmdEnter' as const, metaKey: true, ctrlKey: false },
    { sendShortcut: 'cmdEnter' as const, metaKey: false, ctrlKey: true },
  ])('keeps native/React, repeats and beforeinput to one $sendShortcut submission', (options) => {
    const fixture = mountKeyboard(options);
    dispatchEnter(fixture.el, 'keydown', options);
    dispatchEnter(fixture.el, 'keydown', { ...options, repeat: true });
    act(() => { fixture.el.dispatchEvent(createBeforeInputEvent('insertParagraph')); });
    expect(fixture.handleSubmit).toHaveBeenCalledTimes(1);

    // Releasing the modifier before Enter must still end the key cycle.
    dispatchEnter(fixture.el, 'keyup');
    dispatchEnter(fixture.el, 'keydown', options);
    expect(fixture.handleSubmit).toHaveBeenCalledTimes(2);
  });

  it.each(['enter', 'cmdEnter'] as const)(
    'does not send or reselect while holding the completion Enter in %s mode',
    (sendShortcut) => {
      const fixture = mountKeyboard({ sendShortcut, completionOpen: true });
      dispatchEnter(fixture.el, 'keydown');
      dispatchEnter(fixture.el, 'keydown', { repeat: true, ctrlKey: sendShortcut === 'cmdEnter' });
      act(() => { fixture.el.dispatchEvent(createBeforeInputEvent('insertParagraph')); });
      act(() => { fixture.el.dispatchEvent(createBeforeInputEvent('insertParagraph')); });
      expect(fixture.handleSelect).toHaveBeenCalledTimes(1);
      expect(fixture.handleSubmit).not.toHaveBeenCalled();

      dispatchEnter(fixture.el, 'keyup');
      dispatchEnter(fixture.el, 'keydown', { ctrlKey: sendShortcut === 'cmdEnter' });
      expect(fixture.handleSubmit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { sendShortcut: 'enter' as const, completionOpen: false },
    { sendShortcut: 'enter' as const, completionOpen: true },
    { sendShortcut: 'cmdEnter' as const, completionOpen: false },
    { sendShortcut: 'cmdEnter' as const, completionOpen: true },
  ])('keeps a held IME confirmation owned in $sendShortcut mode (completion: $completionOpen)', (options) => {
    const fixture = mountKeyboard(options);
    fixture.state.isComposingRef.current = true;
    const first = dispatchEnter(fixture.el, 'keydown', { isComposing: true });
    fixture.state.isComposingRef.current = false;
    fixture.state.lastCompositionEndTimeRef.current = Date.now() - 101;
    const repeat = dispatchEnter(fixture.el, 'keydown', { repeat: true });
    const beforeInput = createBeforeInputEvent('insertParagraph');
    act(() => { fixture.el.dispatchEvent(beforeInput); });

    expect(first.defaultPrevented).toBe(false);
    expect(repeat.defaultPrevented).toBe(true);
    expect(beforeInput.defaultPrevented).toBe(true);
    expect(fixture.handleSubmit).not.toHaveBeenCalled();
    expect(fixture.handleSelect).not.toHaveBeenCalled();

    dispatchEnter(fixture.el, 'keyup');
    expect(fixture.state.submittedOnEnterRef.current).toBe(false);
    dispatchEnter(fixture.el, 'keydown', { ctrlKey: options.sendShortcut === 'cmdEnter' });
    if (options.completionOpen) {
      expect(fixture.handleSelect).toHaveBeenCalledTimes(1);
    } else {
      expect(fixture.handleSubmit).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['enter', 'cmdEnter'] as const)(
    'blocks a stray line break after Shift+Enter selects a completion in %s mode',
    (sendShortcut) => {
      const fixture = mountKeyboard({ sendShortcut, completionOpen: true });
      dispatchEnter(fixture.el, 'keydown', { shiftKey: true });
      const beforeInput = createBeforeInputEvent('insertLineBreak');
      act(() => { fixture.el.dispatchEvent(beforeInput); });

      expect(beforeInput.defaultPrevented).toBe(true);
      expect(fixture.handleSelect).toHaveBeenCalledTimes(1);
      expect(fixture.handleSubmit).not.toHaveBeenCalled();

      dispatchEnter(fixture.el, 'keyup', { shiftKey: true });
      dispatchEnter(fixture.el, 'keydown', { shiftKey: true });
      const nextLineBreak = createBeforeInputEvent('insertLineBreak');
      act(() => { fixture.el.dispatchEvent(nextLineBreak); });
      expect(nextLineBreak.defaultPrevented).toBe(false);
    },
  );

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    'blocks a stray line break after modified Shift+Enter sends (%j)',
    (modifier) => {
      const fixture = mountKeyboard({ sendShortcut: 'cmdEnter' });
      dispatchEnter(fixture.el, 'keydown', { shiftKey: true, ...modifier });
      const beforeInput = createBeforeInputEvent('insertLineBreak');
      act(() => { fixture.el.dispatchEvent(beforeInput); });

      expect(beforeInput.defaultPrevented).toBe(true);
      expect(fixture.handleSubmit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    // Chromium maps Shift+Enter to insertLineBreak and plain Enter to insertParagraph.
    { sendShortcut: 'enter' as const, shiftKey: true, inputType: 'insertLineBreak' },
    { sendShortcut: 'cmdEnter' as const, shiftKey: false, inputType: 'insertParagraph' },
  ])('keeps repeated newline Enter available in $sendShortcut mode', ({ inputType, ...options }) => {
    const fixture = mountKeyboard(options);
    const first = dispatchEnter(fixture.el, 'keydown', options);
    const repeat = dispatchEnter(fixture.el, 'keydown', { ...options, repeat: true });
    const beforeInput = createBeforeInputEvent(inputType);
    act(() => { fixture.el.dispatchEvent(beforeInput); });

    expect(first.defaultPrevented).toBe(false);
    expect(repeat.defaultPrevented).toBe(false);
    expect(beforeInput.defaultPrevented).toBe(false);
    expect(fixture.handleSubmit).not.toHaveBeenCalled();
  });

  it.each(['enter', 'cmdEnter'] as const)(
    'does not let Shift+Enter pick a completion during live composition in %s mode',
    (sendShortcut) => {
      const fixture = mountKeyboard({ sendShortcut, completionOpen: true });
      fixture.state.isComposingRef.current = true;

      const keydown = dispatchEnter(fixture.el, 'keydown', { shiftKey: true, isComposing: true });
      const beforeInput = createBeforeInputEvent('insertLineBreak');
      act(() => { fixture.el.dispatchEvent(beforeInput); });

      expect(keydown.defaultPrevented).toBe(false);
      expect(beforeInput.defaultPrevented).toBe(false);
      expect(fixture.handleSelect).not.toHaveBeenCalled();
      expect(fixture.handleSubmit).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not reinterpret the same IME confirmation when the time guard expires during propagation (completion: %s)',
    (completionOpen) => {
      const fixture = mountKeyboard({ completionOpen });
      const committedAt = Date.now();
      fixture.state.lastCompositionEndTimeRef.current = committedAt;
      const clock = vi.spyOn(Date, 'now')
        .mockReturnValueOnce(committedAt + 99)
        .mockReturnValue(committedAt + 100);

      try {
        const event = dispatchEnter(fixture.el, 'keydown');

        expect(event.defaultPrevented).toBe(false);
        expect(fixture.handleSubmit).not.toHaveBeenCalled();
        expect(fixture.handleSelect).not.toHaveBeenCalled();
        expect(fixture.state.submittedOnEnterRef.current).toBe(true);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('guards plain IME confirmation even with the CmdEnter preference', () => {
    const fixture = mountKeyboard({ sendShortcut: 'cmdEnter', completionOpen: true, recentlyComposing: true });
    dispatchEnter(fixture.el, 'keydown');
    expect(fixture.handleSelect).not.toHaveBeenCalled();
    expect(fixture.handleSubmit).not.toHaveBeenCalled();
  });

  it('keeps native callbacks on committed options during a suspended render', async () => {
    const onSubmit = vi.fn();
    const never = new Promise<void>(() => {});
    let changeVersion: (version: string) => void = () => {};
    let pendingRendered = false;

    function Editor({ version }: { version: string }) {
      const editableRef = useRef<HTMLDivElement>(null);
      const closed = { isOpen: false };
      useNativeEventCapture({
        editableRef,
        isComposingRef: useRef(false),
        lastCompositionEndTimeRef: useRef(0),
        submittedOnEnterRef: useRef(false),
        completionSelectedRef: useRef(false),
        sendShortcut: 'enter',
        fileCompletion: closed,
        commandCompletion: closed,
        agentCompletion: closed,
        promptCompletion: closed,
        dollarCommandCompletion: closed,
        handleSubmit: () => onSubmit(version),
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: () => {},
      });
      if (version === 'pending') {
        pendingRendered = true;
        throw never;
      }
      return createElement('div', { ref: editableRef, 'data-version': version });
    }

    function Fixture() {
      const [version, setVersion] = useState('committed');
      changeVersion = setVersion;
      return createElement(Suspense, { fallback: 'loading' }, createElement(Editor, { version }));
    }

    const view = render(createElement(Fixture));
    await act(async () => { startTransition(() => changeVersion('pending')); });
    expect(pendingRendered).toBe(true);
    const el = view.container.querySelector('[data-version="committed"]')!;
    dispatchEnter(el, 'keydown');
    expect(onSubmit).toHaveBeenLastCalledWith('committed');

    act(() => { changeVersion('updated'); });
    dispatchEnter(el, 'keyup');
    dispatchEnter(el, 'keydown');
    expect(onSubmit).toHaveBeenLastCalledWith('updated');
  });

  it('submits on Enter in enter mode when no completions are open', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();
    const handleEnhancePrompt = vi.fn();
    const submittedOnEnterRef = { current: false };
    const completionSelectedRef = { current: false };

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt,
      })
    );

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }));
    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(submittedOnEnterRef.current).toBe(true);
  });

  it('sends with the submit callback committed after the first frame', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const firstSubmit = vi.fn();
    const latestSubmit = vi.fn();
    const submittedOnEnterRef = { current: false };
    const completionSelectedRef = { current: false };
    const base = {
      editableRef: { current: el },
      isComposingRef: { current: false },
      lastCompositionEndTimeRef: { current: Date.now() - 1000 },
      sendShortcut: 'enter' as const,
      fileCompletion: { isOpen: false },
      commandCompletion: { isOpen: false },
      agentCompletion: { isOpen: false },
      promptCompletion: { isOpen: false },
      dollarCommandCompletion: { isOpen: false },
      completionSelectedRef,
      submittedOnEnterRef,
      handleCompositionEnd: vi.fn(),
      handleEnhancePrompt: () => {},
    };

    const { rerender } = renderHook(
      ({ handleSubmit }) => useNativeEventCapture({ ...base, handleSubmit }),
      { initialProps: { handleSubmit: firstSubmit } },
    );
    rerender({ handleSubmit: latestSubmit });
    submittedOnEnterRef.current = false;

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }));
    expect(firstSubmit).not.toHaveBeenCalled();
    expect(latestSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit when completion is open', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: true },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef: { current: false },
        handleSubmit,
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: vi.fn(),
      })
    );

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }));
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('handles enhance prompt shortcut (Cmd+/)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleEnhancePrompt = vi.fn();

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef: { current: false },
        handleSubmit: vi.fn(),
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt,
      })
    );

    el.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }));
    expect(handleEnhancePrompt).toHaveBeenCalledTimes(1);
  });

  it('lets native capture own Enter before React sees the same keydown', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();
    const isComposingRef = { current: false };
    const lastCompositionEndTimeRef = { current: Date.now() - 1000 };
    const submittedOnEnterRef = { current: false };
    const completionSelectedRef = { current: false };

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef,
        lastCompositionEndTimeRef,
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: vi.fn(),
      })
    );

    const { result } = renderHook(() =>
      useKeyboardHandler({
        isComposingRef,
        lastCompositionEndTimeRef,
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        commandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        agentCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        promptCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        dollarCommandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        handleMacCursorMovement: vi.fn(() => false),
        handleHistoryKeyDown: vi.fn(() => false),
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
      })
    );

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    result.current.onKeyDown({
      key: event.key,
      defaultPrevented: event.defaultPrevented,
      nativeEvent: event,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLDivElement>);

    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });

  it('blocks IME insertParagraph without submitting during and after composition', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();
    const isComposingRef = { current: true };
    const lastCompositionEndTimeRef = { current: 0 };
    const submittedOnEnterRef = { current: false };

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef,
        lastCompositionEndTimeRef,
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef,
        handleSubmit,
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: vi.fn(),
      })
    );

    el.dispatchEvent(createBeforeInputEvent('insertParagraph', true));
    expect(handleSubmit).not.toHaveBeenCalled();
    expect(submittedOnEnterRef.current).toBe(false);

    isComposingRef.current = false;
    lastCompositionEndTimeRef.current = Date.now();
    el.dispatchEvent(createBeforeInputEvent('insertParagraph'));
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('does not submit beforeinput after keydown already submitted', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();
    const submittedOnEnterRef = { current: false };

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef,
        handleSubmit,
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: vi.fn(),
      })
    );

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }));
    el.dispatchEvent(createBeforeInputEvent('insertParagraph'));
    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });

  it('leaves Shift+Enter available for newline insertion', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef: { current: false },
        handleSubmit,
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: vi.fn(),
      })
    );

    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(keydown);
    // Chromium reports Shift+Enter as insertLineBreak, never insertParagraph.
    const beforeInput = createBeforeInputEvent('insertLineBreak');
    el.dispatchEvent(beforeInput);

    expect(keydown.defaultPrevented).toBe(false);
    expect(beforeInput.defaultPrevented).toBe(false);
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('sends Cmd+Enter immediately after composition ends', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() },
        sendShortcut: 'cmdEnter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef: { current: false },
        handleSubmit,
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: vi.fn(),
      })
    );

    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      cancelable: true,
    }));

    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });

  it('releases the submit guard when Cmd+Enter keyup loses its modifier', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const submittedOnEnterRef = { current: true };

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'cmdEnter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        promptCompletion: { isOpen: false },
        dollarCommandCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef,
        handleSubmit: vi.fn(),
        handleCompositionEnd: vi.fn(),
        handleEnhancePrompt: vi.fn(),
      })
    );

    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));

    expect(submittedOnEnterRef.current).toBe(false);
  });
});
