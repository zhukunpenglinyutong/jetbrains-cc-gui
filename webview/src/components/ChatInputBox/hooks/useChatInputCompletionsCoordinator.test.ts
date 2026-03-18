import { renderHook } from '@testing-library/react';
import { useChatInputCompletionsCoordinator } from './useChatInputCompletionsCoordinator.js';

const completionMocks: Array<{ close: ReturnType<typeof vi.fn>; isOpen: boolean }> = [];
const inlineCompletionMock = {
  suffix: '',
  hasSuggestion: false,
  updateQuery: vi.fn(),
  clear: vi.fn(),
  applySuggestion: vi.fn(),
};
const debouncedDetectCompletion = vi.fn();

vi.mock('./useCompletionDropdown.js', () => ({
  useCompletionDropdown: vi.fn(() => {
    const mock = {
      isOpen: false,
      close: vi.fn(),
      open: vi.fn(),
      updateQuery: vi.fn(),
      replaceText: vi.fn((text: string, replacement: string) => text + replacement),
      position: null,
      items: [],
      activeIndex: 0,
      loading: false,
      handleMouseEnter: vi.fn(),
      selectIndex: vi.fn(),
    };
    completionMocks.push(mock);
    return mock;
  }),
}));

vi.mock('./useInlineHistoryCompletion.js', () => ({
  useInlineHistoryCompletion: vi.fn(() => inlineCompletionMock),
}));

vi.mock('./useCompletionTriggerDetection.js', () => ({
  useCompletionTriggerDetection: vi.fn(() => ({
    debouncedDetectCompletion,
  })),
}));

describe('useChatInputCompletionsCoordinator', () => {
  beforeEach(() => {
    completionMocks.length = 0;
    inlineCompletionMock.updateQuery.mockReset();
    inlineCompletionMock.clear.mockReset();
    debouncedDetectCompletion.mockReset();
  });

  it('closes all completion controllers and syncs inline completion state', () => {
    const closeAllCompletionsRef = { current: vi.fn() };

    const { result } = renderHook(() =>
      useChatInputCompletionsCoordinator({
        editableRef: { current: document.createElement('div') },
        sharedComposingRef: { current: false },
        justRenderedTagRef: { current: false },
        getTextContent: () => '',
        pathMappingRef: { current: new Map() },
        setCursorAfterPath: vi.fn(),
        closeAllCompletionsRef,
        handleInputRef: { current: vi.fn() },
        currentProvider: 'claude',
      })
    );

    result.current.closeAllCompletions();
    expect(completionMocks).toHaveLength(5);
    completionMocks.forEach((mock) => {
      expect(mock.close).toHaveBeenCalled();
    });

    result.current.syncInlineCompletion('hello');
    expect(inlineCompletionMock.updateQuery).toHaveBeenCalledWith('hello');
    expect(inlineCompletionMock.clear).not.toHaveBeenCalled();

    completionMocks[0].isOpen = true;
    result.current.syncInlineCompletion('world');
    expect(inlineCompletionMock.clear).toHaveBeenCalled();
    expect(closeAllCompletionsRef.current).toBe(result.current.closeAllCompletions);
    expect(result.current.debouncedDetectCompletion).toBe(debouncedDetectCompletion);
  });
});
