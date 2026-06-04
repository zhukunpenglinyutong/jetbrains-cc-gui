import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePromptEnhancer } from './usePromptEnhancer';

describe('usePromptEnhancer', () => {
  const bridgeCall = (type: string, content = '') =>
    JSON.stringify({ type, content });

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('sends only prompt payload when requesting enhancement', () => {
    const editableRef = { current: document.createElement('div') };
    const setHasContent = vi.fn();
    const onInput = vi.fn();

    const { result } = renderHook(() => usePromptEnhancer({
      editableRef,
      getTextContent: () => 'Please refactor this module',
      setHasContent,
      onInput,
    }));

    act(() => {
      result.current.handleEnhancePrompt();
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      bridgeCall('enhance_prompt', '{"prompt":"Please refactor this module"}')
    );
  });
});
