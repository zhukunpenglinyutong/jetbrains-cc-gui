import { renderHook } from '@testing-library/react';
import type React from 'react';
import { useKeyboardHandler } from './useKeyboardHandler.js';

function reactKeyEvent({
  key,
  metaKey = false,
  ctrlKey = false,
  shiftKey = false,
  isComposing = false,
}: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}) {
  const e = {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    nativeEvent: { isComposing, key },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  return e as unknown as React.KeyboardEvent<HTMLDivElement>;
}

describe('useKeyboardHandler', () => {
  it('sends on Enter (enter mode) when allowed', () => {
    const handleSubmit = vi.fn();
    const submittedOnEnterRef = { current: false };
    const completionSelectedRef = { current: false };

    const { result } = renderHook(() =>
      useKeyboardHandler({
        isComposing: false,
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        sdkStatusLoading: false,
        sdkInstalled: true,
        fileCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        commandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        agentCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        handleMacCursorMovement: vi.fn(() => false),
        handleHistoryKeyDown: vi.fn(() => false),
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
      })
    );

    const e = reactKeyEvent({ key: 'Enter' });
    result.current.onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(submittedOnEnterRef.current).toBe(true);
  });

  it('does not send when completion handles Enter', () => {
    const handleSubmit = vi.fn();
    const submittedOnEnterRef = { current: false };
    const completionSelectedRef = { current: false };

    const { result } = renderHook(() =>
      useKeyboardHandler({
        isComposing: false,
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        sdkStatusLoading: false,
        sdkInstalled: true,
        fileCompletion: { isOpen: true, handleKeyDown: vi.fn(() => true) },
        commandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        agentCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        handleMacCursorMovement: vi.fn(() => false),
        handleHistoryKeyDown: vi.fn(() => false),
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
      })
    );

    const e = reactKeyEvent({ key: 'Enter' });
    result.current.onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(completionSelectedRef.current).toBe(true);
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('resets submit refs on key up', () => {
    const handleSubmit = vi.fn();
    const submittedOnEnterRef = { current: true };
    const completionSelectedRef = { current: false };

    const { result } = renderHook(() =>
      useKeyboardHandler({
        isComposing: false,
        lastCompositionEndTimeRef: { current: Date.now() - 1000 },
        sendShortcut: 'enter',
        sdkStatusLoading: false,
        sdkInstalled: true,
        fileCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        commandCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        agentCompletion: { isOpen: false, handleKeyDown: vi.fn(() => false) },
        handleMacCursorMovement: vi.fn(() => false),
        handleHistoryKeyDown: vi.fn(() => false),
        completionSelectedRef,
        submittedOnEnterRef,
        handleSubmit,
      })
    );

    const e = reactKeyEvent({ key: 'Enter' });
    result.current.onKeyUp(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(submittedOnEnterRef.current).toBe(false);
  });
});

