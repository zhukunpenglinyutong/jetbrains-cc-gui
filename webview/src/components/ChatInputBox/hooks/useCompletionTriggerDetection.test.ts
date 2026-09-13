import { renderHook } from '@testing-library/react';
import { useCompletionTriggerDetection } from './useCompletionTriggerDetection.js';

function createCompletion() {
  // Fresh literal each call — mirrors useCompletionDropdown's real behavior
  return {
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    updateQuery: vi.fn(),
  };
}

function setup() {
  const editable = document.createElement('div');
  document.body.appendChild(editable);
  return editable;
}

describe('useCompletionTriggerDetection', () => {
  it('keeps a stable debounced function across re-renders with fresh completion objects', () => {
    const editable = setup();

    const { result, rerender } = renderHook(
      ({ completions }) =>
        useCompletionTriggerDetection({
          editableRef: { current: editable },
          sharedComposingRef: { current: false },
          justRenderedTagRef: { current: false },
          getTextContent: () => editable.textContent ?? '',
          fileCompletion: completions.file,
          commandCompletion: completions.command,
          agentCompletion: completions.agent,
          promptCompletion: completions.prompt,
          dollarCommandCompletion: completions.dollar,
        }),
      {
        initialProps: {
          completions: {
            file: createCompletion(),
            command: createCompletion(),
            agent: createCompletion(),
            prompt: createCompletion(),
            dollar: createCompletion(),
          },
        },
      }
    );

    const first = result.current.debouncedDetectCompletion;

    // Re-render with brand-new completion objects (what happens every render)
    rerender({
      completions: {
        file: createCompletion(),
        command: createCompletion(),
        agent: createCompletion(),
        prompt: createCompletion(),
        dollar: createCompletion(),
      },
    });

    // Regression: the debounced instance must not be recreated per render —
    // orphaned debounce timers fire with stale closures and re-open/clear the
    // dropdown ("flash then loading" flicker).
    expect(result.current.debouncedDetectCompletion).toBe(first);
  });
});
