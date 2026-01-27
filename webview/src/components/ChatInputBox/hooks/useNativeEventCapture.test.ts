import { renderHook } from '@testing-library/react';
import { useNativeEventCapture } from './useNativeEventCapture.js';

describe('useNativeEventCapture', () => {
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
        isComposing: false,
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
        handleEnhancePrompt,
      })
    );

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }));
    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(submittedOnEnterRef.current).toBe(true);
  });

  it('does not submit when completion is open', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const handleSubmit = vi.fn();

    renderHook(() =>
      useNativeEventCapture({
        editableRef: { current: el },
        isComposing: false,
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: true },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef: { current: false },
        handleSubmit,
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
        isComposing: false,
        isComposingRef: { current: false },
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        fileCompletion: { isOpen: false },
        commandCompletion: { isOpen: false },
        agentCompletion: { isOpen: false },
        completionSelectedRef: { current: false },
        submittedOnEnterRef: { current: false },
        handleSubmit: vi.fn(),
        handleEnhancePrompt,
      })
    );

    el.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }));
    expect(handleEnhancePrompt).toHaveBeenCalledTimes(1);
  });
});

