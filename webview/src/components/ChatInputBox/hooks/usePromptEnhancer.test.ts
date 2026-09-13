import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEnhancedPromptPayload, usePromptEnhancer } from './usePromptEnhancer';

describe('applyEnhancedPromptPayload', () => {
  it('keeps enhancing while streaming partial text', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: true, enhancedPrompt: 'partial text', done: false },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('partial text');
    expect(setIsEnhancing).not.toHaveBeenCalled();
  });

  it('stops enhancing when done is true', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: true, enhancedPrompt: 'final text', done: true },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('final text');
    expect(setIsEnhancing).toHaveBeenCalledWith(false);
  });

  it('treats missing done as finished for backward compatibility', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: true, enhancedPrompt: 'legacy final' },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('legacy final');
    expect(setIsEnhancing).toHaveBeenCalledWith(false);
  });

  it('shows error text when finished with failure', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();

    applyEnhancedPromptPayload(
      { success: false, error: 'SDK missing', done: true },
      { setEnhancedPrompt, setIsEnhancing }
    );

    expect(setEnhancedPrompt).toHaveBeenCalledWith('SDK missing');
    expect(setIsEnhancing).toHaveBeenCalledWith(false);
  });

  it('applies usage meta without requiring enhanced text', () => {
    const setEnhancedPrompt = vi.fn();
    const setIsEnhancing = vi.fn();
    const setUsageInfo = vi.fn();

    applyEnhancedPromptPayload(
      {
        success: true,
        enhancedPrompt: '',
        done: false,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        resolutionSource: 'auto',
      },
      { setEnhancedPrompt, setIsEnhancing, setUsageInfo }
    );

    expect(setEnhancedPrompt).not.toHaveBeenCalled();
    expect(setIsEnhancing).not.toHaveBeenCalled();
    expect(setUsageInfo).toHaveBeenCalledWith({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      resolutionSource: 'auto',
    });
  });

  it('maps invalid resolutionSource to null', () => {
    const setUsageInfo = vi.fn();
    applyEnhancedPromptPayload(
      {
        success: true,
        enhancedPrompt: 'ok',
        done: true,
        provider: 'codex',
        model: 'gpt-5.5',
        resolutionSource: 'weird',
      },
      { setEnhancedPrompt: vi.fn(), setIsEnhancing: vi.fn(), setUsageInfo }
    );
    expect(setUsageInfo).toHaveBeenCalledWith({
      provider: 'codex',
      model: 'gpt-5.5',
      resolutionSource: null,
    });
  });
});

describe('usePromptEnhancer', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('sends prompt plus chat provider/model for auto model follow', () => {
    const editableRef = { current: document.createElement('div') };
    const setHasContent = vi.fn();
    const onInput = vi.fn();

    const { result } = renderHook(() => usePromptEnhancer({
      editableRef,
      getTextContent: () => 'Please refactor this module',
      setHasContent,
      onInput,
      currentProvider: 'opencode',
      selectedModel: 'opencode/deepseek-v4-flash-free',
    }));

    act(() => {
      result.current.handleEnhancePrompt();
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'enhance_prompt:{"prompt":"Please refactor this module","chatProvider":"opencode","chatModel":"opencode/deepseek-v4-flash-free"}'
    );
    expect(result.current.usageInfo).toBeNull();
  });

  it('omits chat fields when provider/model are empty', () => {
    const editableRef = { current: document.createElement('div') };

    const { result } = renderHook(() => usePromptEnhancer({
      editableRef,
      getTextContent: () => 'hello',
      setHasContent: vi.fn(),
      currentProvider: '  ',
      selectedModel: '',
    }));

    act(() => {
      result.current.handleEnhancePrompt();
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'enhance_prompt:{"prompt":"hello"}'
    );
  });

  it('streams partial text then finalizes on done', () => {
    const editableRef = { current: document.createElement('div') };

    const { result } = renderHook(() => usePromptEnhancer({
      editableRef,
      getTextContent: () => 'hello',
      setHasContent: vi.fn(),
    }));

    act(() => {
      result.current.handleEnhancePrompt();
    });
    expect(result.current.isEnhancing).toBe(true);

    act(() => {
      window.updateEnhancedPrompt?.(JSON.stringify({
        success: true,
        enhancedPrompt: 'Hel',
        done: false,
      }));
    });
    expect(result.current.enhancedPrompt).toBe('Hel');
    expect(result.current.isEnhancing).toBe(true);

    act(() => {
      window.updateEnhancedPrompt?.(JSON.stringify({
        success: true,
        enhancedPrompt: 'Hello world',
        done: true,
      }));
    });
    expect(result.current.enhancedPrompt).toBe('Hello world');
    expect(result.current.isEnhancing).toBe(false);
  });

  it('captures usage meta while still enhancing', () => {
    const editableRef = { current: document.createElement('div') };

    const { result } = renderHook(() => usePromptEnhancer({
      editableRef,
      getTextContent: () => 'hello',
      setHasContent: vi.fn(),
    }));

    act(() => {
      result.current.handleEnhancePrompt();
    });

    act(() => {
      window.updateEnhancedPrompt?.(JSON.stringify({
        success: true,
        enhancedPrompt: '',
        done: false,
        provider: 'grok',
        model: 'grok',
        resolutionSource: 'manual',
      }));
    });

    expect(result.current.isEnhancing).toBe(true);
    expect(result.current.usageInfo).toEqual({
      provider: 'grok',
      model: 'grok',
      resolutionSource: 'manual',
    });
  });
});
