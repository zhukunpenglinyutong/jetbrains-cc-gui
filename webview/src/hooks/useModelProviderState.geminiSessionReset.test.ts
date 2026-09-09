import { act, renderHook } from '@testing-library/react';
import { useModelProviderState } from './useModelProviderState.js';

/**
 * Story 1.3, Task 4 / AC3: for gemini a model change — including an
 * effort-tier change, because family+effort is ONE slug — must discard the
 * backend conversation before the next send. The hook fires
 * `onSessionResetRequest`; App wires it to `forceCreateNewSession`
 * (interrupt if streaming → beginSessionTransition → create_new_session).
 *
 * Regression guard (Task 4): the reset is strictly gemini-gated — claude,
 * codex and grok model selections must never fire it.
 */
describe('useModelProviderState gemini conversation reset (Story 1.3)', () => {
  const t = ((key: string) => key) as any;
  const addToast = vi.fn();

  beforeEach(() => {
    window.sendToJava = vi.fn();
    // useModelStatePersistence restores the persisted provider/model on mount.
    localStorage.clear();
  });

  function setup() {
    const onSessionResetRequest = vi.fn();
    const rendered = renderHook(() =>
      useModelProviderState({ addToast, t, onSessionResetRequest })
    );
    return { onSessionResetRequest, ...rendered };
  }

  const selectModel = (result: ReturnType<typeof setup>['result'], modelId: string) => {
    act(() => {
      result.current.handleModelSelect(modelId);
    });
  };

  it('requests a session reset when the gemini model slug changes', () => {
    const { result, onSessionResetRequest } = setup();

    act(() => {
      result.current.setCurrentProvider('gemini');
    });
    selectModel(result, 'gemini-3.6-flash-high');

    expect(window.sendToJava).toHaveBeenCalledWith('set_model:gemini-3.6-flash-high');
    expect(onSessionResetRequest).toHaveBeenCalledTimes(1);
  });

  it('treats an effort-tier change as a model change (family+effort is one slug)', () => {
    const { result, onSessionResetRequest } = setup();

    act(() => {
      result.current.setCurrentProvider('gemini');
    });
    selectModel(result, 'gemini-3.6-flash-high');
    selectModel(result, 'gemini-3.6-flash-medium');

    expect(onSessionResetRequest).toHaveBeenCalledTimes(2);
    expect(window.sendToJava).toHaveBeenLastCalledWith('set_model:gemini-3.6-flash-medium');
  });

  it('does not reset when the same slug is reaffirmed', () => {
    const { result, onSessionResetRequest } = setup();

    act(() => {
      result.current.setCurrentProvider('gemini');
    });
    selectModel(result, 'gemini-3.6-flash-high');
    selectModel(result, 'gemini-3.6-flash-high');

    // First selection changes '' → slug (reset), the reaffirmation is a no-op,
    // mirroring Java's isActualModelSwitch.
    expect(onSessionResetRequest).toHaveBeenCalledTimes(1);
    expect(window.sendToJava).toHaveBeenCalledWith('set_model:gemini-3.6-flash-high');
  });

  it('never fires the reset for claude model selections', () => {
    const { result, onSessionResetRequest } = setup();

    selectModel(result, 'claude-sonnet-5');

    expect(onSessionResetRequest).not.toHaveBeenCalled();
    // The claude path keeps its own normalization/1M-suffix behavior — only
    // the ABSENCE of the reset is pinned here.
    expect(window.sendToJava).toHaveBeenCalledWith(
      expect.stringMatching(/^set_model:claude-sonnet-5(\[1m\])?$/)
    );
  });

  it('never fires the reset for codex model selections', () => {
    const { result, onSessionResetRequest } = setup();

    act(() => {
      result.current.setCurrentProvider('codex');
    });
    selectModel(result, 'gpt-5.4-codex');

    expect(onSessionResetRequest).not.toHaveBeenCalled();
    expect(window.sendToJava).toHaveBeenCalledWith('set_model:gpt-5.4-codex');
  });

  it('never fires the reset for grok model selections', () => {
    const { result, onSessionResetRequest } = setup();

    act(() => {
      result.current.setCurrentProvider('grok');
    });
    selectModel(result, 'grok-4');

    expect(onSessionResetRequest).not.toHaveBeenCalled();
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
    const onSessionResetRequest = vi.fn();
    const rendered = renderHook(() =>
      useModelProviderState({ addToast, t, onSessionResetRequest })
    );
    return { onSessionResetRequest, ...rendered };
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
