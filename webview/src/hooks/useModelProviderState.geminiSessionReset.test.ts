import { act, renderHook } from '@testing-library/react';
import { useModelProviderState } from './useModelProviderState.js';

/**
 * Story 1.13 (supersedes Story 1.3 AC3 / CAP-4 model-change reset):
 * For Gemini, picking another model or effort tier leaves the conversation on screen
 * and continues the session. The hook sends `set_model` and no session reset is requested.
 *
 * Regression guard: Claude, Codex, and Grok model selections also never request a reset.
 */
describe('useModelProviderState gemini conversation continuity on model change (Story 1.13)', () => {
  const t = ((key: string) => key) as any;
  const addToast = vi.fn();

  beforeEach(() => {
    window.sendToJava = vi.fn();
    // useModelStatePersistence restores the persisted provider/model on mount.
    localStorage.clear();
  });

  function setup() {
    return renderHook(() => useModelProviderState({ addToast, t }));
  }

  const selectModel = (result: ReturnType<typeof setup>['result'], modelId: string) => {
    act(() => {
      result.current.handleModelSelect(modelId);
    });
  };

  it('sends set_model and does not request a session reset when the gemini model slug changes', () => {
    const { result } = setup();

    act(() => {
      result.current.setCurrentProvider('gemini');
    });
    (window.sendToJava as ReturnType<typeof vi.fn>).mockClear();
    selectModel(result, 'gemini-3.6-flash-high');

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).toHaveBeenCalledWith('set_model:gemini-3.6-flash-high');
  });

  it('sends both slugs and does not request a session reset on effort-tier changes', () => {
    const { result } = setup();

    act(() => {
      result.current.setCurrentProvider('gemini');
    });
    (window.sendToJava as ReturnType<typeof vi.fn>).mockClear();
    selectModel(result, 'gemini-3.6-flash-high');
    selectModel(result, 'gemini-3.6-flash-medium');

    expect(window.sendToJava).toHaveBeenNthCalledWith(1, 'set_model:gemini-3.6-flash-high');
    expect(window.sendToJava).toHaveBeenNthCalledWith(2, 'set_model:gemini-3.6-flash-medium');
    expect(window.sendToJava).toHaveBeenCalledTimes(2);
  });

  it('sends set_model twice and does not request a session reset when the same slug is reaffirmed', () => {
    const { result } = setup();

    act(() => {
      result.current.setCurrentProvider('gemini');
    });
    (window.sendToJava as ReturnType<typeof vi.fn>).mockClear();
    selectModel(result, 'gemini-3.6-flash-high');
    selectModel(result, 'gemini-3.6-flash-high');

    expect(window.sendToJava).toHaveBeenNthCalledWith(1, 'set_model:gemini-3.6-flash-high');
    expect(window.sendToJava).toHaveBeenNthCalledWith(2, 'set_model:gemini-3.6-flash-high');
    expect(window.sendToJava).toHaveBeenCalledTimes(2);
  });

  it('never fires a session reset for claude model selections and sends set_model', () => {
    const { result } = setup();
    (window.sendToJava as ReturnType<typeof vi.fn>).mockClear();

    selectModel(result, 'claude-sonnet-5');

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).toHaveBeenCalledWith(
      expect.stringMatching(/^set_model:claude-sonnet-5(\[1m\])?$/)
    );
  });

  it('never fires a session reset for codex model selections and sends set_model', () => {
    const { result } = setup();

    act(() => {
      result.current.setCurrentProvider('codex');
    });
    (window.sendToJava as ReturnType<typeof vi.fn>).mockClear();
    selectModel(result, 'gpt-5.4-codex');

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).toHaveBeenCalledWith('set_model:gpt-5.4-codex');
  });

  it('never fires a session reset for grok model selections and sends set_model', () => {
    const { result } = setup();

    act(() => {
      result.current.setCurrentProvider('grok');
    });
    (window.sendToJava as ReturnType<typeof vi.fn>).mockClear();
    selectModel(result, 'grok-4');

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).toHaveBeenCalledWith('set_model:grok-4');
  });
});

describe('useModelProviderState gemini model wiring (Story 1.4 review)', () => {
  const t = ((key: string) => key) as any;
  const addToast = vi.fn();

  beforeEach(() => {
    window.sendToJava = vi.fn();
    localStorage.clear();
  });

  function setup() {
    return renderHook(() => useModelProviderState({ addToast, t }));
  }

  const selectModel = (result: ReturnType<typeof setup>['result'], modelId: string) => {
    act(() => {
      result.current.handleModelSelect(modelId);
    });
  };

  it('exposes the gemini slot through selectedModel: auto by default, the picked slug after', () => {
    const { result } = setup();

    act(() => {
      result.current.setCurrentProvider('gemini');
    });
    // 'auto' is a real, honest choice (omit --model) — never a borrowed
    // claude slug and never ''.
    expect(result.current.selectedModel).toBe('auto');

    selectModel(result, 'gemini-3.7-flash-medium');
    expect(result.current.selectedModel).toBe('gemini-3.7-flash-medium');
  });

  it('provider switch to gemini re-points set_model away from a picked claude slug', () => {
    const { result } = setup();

    selectModel(result, 'claude-sonnet-5');
    // The claude pick carries the optional [1m] long-context suffix; only its
    // presence matters here — the test's subject is what the SWITCH sends.
    expect(window.sendToJava).toHaveBeenCalledWith(
      expect.stringMatching(/^set_model:claude-sonnet-5(\[1m\])?$/)
    );

    act(() => {
      result.current.handleProviderSelect('gemini');
    });

    expect(window.sendToJava).toHaveBeenCalledWith('set_provider:gemini');
    // The LAST set_model must carry the gemini slot ('auto' until the user
    // picks) — a claude slug forwarded to the agy CLI would be a
    // wrong-vendor model.
    expect(window.sendToJava).toHaveBeenLastCalledWith('set_model:auto');
    const setModelCalls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) => typeof event === 'string' && event.startsWith('set_model:')
    );
    expect(setModelCalls.at(-1)).toEqual(['set_model:auto']);
  });
});
