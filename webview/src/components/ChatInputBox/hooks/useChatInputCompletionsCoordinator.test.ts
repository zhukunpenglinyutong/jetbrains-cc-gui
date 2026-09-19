import { renderHook } from '@testing-library/react';
import { useChatInputCompletionsCoordinator } from './useChatInputCompletionsCoordinator.js';
import {
  codexCommandProvider,
  codexCommandToDropdownItem,
  dollarCommandProvider,
  slashCommandProvider,
} from '../providers/index.js';
import type { CommandItem, TriggerQuery } from '../types.js';

const completionMocks: Array<{ close: ReturnType<typeof vi.fn>; isOpen: boolean }> = [];
interface CompletionConfig {
  trigger: string;
  provider: unknown;
  toDropdownItem: unknown;
  onSelect: (item: CommandItem, query: TriggerQuery | null) => void;
}

const completionConfigs: CompletionConfig[] = [];
const inlineCompletionMock = {
  suffix: '',
  hasSuggestion: false,
  updateQuery: vi.fn(),
  clear: vi.fn(),
  applySuggestion: vi.fn(),
};
const debouncedDetectCompletion = vi.fn();

vi.mock('./useCompletionDropdown.js', () => ({
  useCompletionDropdown: vi.fn((options: CompletionConfig) => {
    completionConfigs.push(options);
    const mock = {
      isOpen: false,
      close: vi.fn(),
      open: vi.fn(),
      updateQuery: vi.fn(),
      replaceText: vi.fn((text: string, replacement: string, query: TriggerQuery) =>
        text.slice(0, query.start) + replacement + text.slice(query.end)),
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
    completionConfigs.length = 0;
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

  it('shares the merged Codex provider between slash and dollar triggers', () => {
    renderHook(() =>
      useChatInputCompletionsCoordinator({
        editableRef: { current: document.createElement('div') },
        sharedComposingRef: { current: false },
        justRenderedTagRef: { current: false },
        getTextContent: () => '',
        pathMappingRef: { current: new Map() },
        setCursorAfterPath: vi.fn(),
        closeAllCompletionsRef: { current: vi.fn() },
        handleInputRef: { current: vi.fn() },
        currentProvider: 'codex',
      })
    );

    const slashConfig = completionConfigs.find((config) => config.trigger === '/');
    const dollarConfig = completionConfigs.find((config) => config.trigger === '$');
    expect(slashConfig?.provider).toBe(codexCommandProvider);
    expect(dollarConfig?.provider).toBe(codexCommandProvider);
    expect(slashConfig?.toDropdownItem).toBe(codexCommandToDropdownItem);
    expect(dollarConfig?.toDropdownItem).toBe(codexCommandToDropdownItem);
  });

  it('keeps the slash-only provider for Claude', () => {
    renderHook(() =>
      useChatInputCompletionsCoordinator({
        editableRef: { current: document.createElement('div') },
        sharedComposingRef: { current: false },
        justRenderedTagRef: { current: false },
        getTextContent: () => '',
        pathMappingRef: { current: new Map() },
        setCursorAfterPath: vi.fn(),
        closeAllCompletionsRef: { current: vi.fn() },
        handleInputRef: { current: vi.fn() },
        currentProvider: 'claude',
      })
    );

    expect(completionConfigs.find((config) => config.trigger === '/')?.provider)
      .toBe(slashCommandProvider);
    expect(completionConfigs.find((config) => config.trigger === '$')?.provider)
      .toBe(dollarCommandProvider);
  });

  it('fills each selected Codex item with its semantic invocation prefix', () => {
    const editable = document.createElement('div');
    editable.innerText = '/';
    const handleInput = vi.fn();

    renderHook(() =>
      useChatInputCompletionsCoordinator({
        editableRef: { current: editable },
        sharedComposingRef: { current: false },
        justRenderedTagRef: { current: false },
        getTextContent: () => editable.innerText,
        pathMappingRef: { current: new Map() },
        setCursorAfterPath: vi.fn(),
        closeAllCompletionsRef: { current: vi.fn() },
        handleInputRef: { current: handleInput },
        currentProvider: 'codex',
      })
    );

    completionConfigs.find((config) => config.trigger === '/')?.onSelect(
      { id: 'review-code', label: '$review-code', contentType: 'skill' },
      { trigger: '/', query: '', start: 0, end: 1 }
    );
    expect(editable.innerText).toBe('$review-code ');

    editable.innerText = '$';
    completionConfigs.find((config) => config.trigger === '$')?.onSelect(
      { id: 'review', label: '/review', contentType: 'command' },
      { trigger: '$', query: '', start: 0, end: 1 }
    );
    expect(editable.innerText).toBe('/review ');
    expect(handleInput).toHaveBeenCalledTimes(2);
  });

  it('does not insert a Codex loading placeholder on keyboard selection', () => {
    const editable = document.createElement('div');
    editable.innerText = '/';
    const handleInput = vi.fn();

    renderHook(() =>
      useChatInputCompletionsCoordinator({
        editableRef: { current: editable },
        sharedComposingRef: { current: false },
        justRenderedTagRef: { current: false },
        getTextContent: () => editable.innerText,
        pathMappingRef: { current: new Map() },
        setCursorAfterPath: vi.fn(),
        closeAllCompletionsRef: { current: vi.fn() },
        handleInputRef: { current: handleInput },
        currentProvider: 'codex',
      })
    );

    completionConfigs.find((config) => config.trigger === '/')?.onSelect(
      { id: '__loading__', label: 'Loading' },
      { trigger: '/', query: '', start: 0, end: 1 }
    );

    expect(editable.innerText).toBe('/');
    expect(handleInput).not.toHaveBeenCalled();
  });

  it('preserves the original Claude command label when selected', () => {
    const editable = document.createElement('div');
    editable.innerText = '/';

    renderHook(() =>
      useChatInputCompletionsCoordinator({
        editableRef: { current: editable },
        sharedComposingRef: { current: false },
        justRenderedTagRef: { current: false },
        getTextContent: () => editable.innerText,
        pathMappingRef: { current: new Map() },
        setCursorAfterPath: vi.fn(),
        closeAllCompletionsRef: { current: vi.fn() },
        handleInputRef: { current: vi.fn() },
        currentProvider: 'claude',
      })
    );

    completionConfigs.find((config) => config.trigger === '/')?.onSelect(
      { id: 'legacy', label: '/$legacy' },
      { trigger: '/', query: '', start: 0, end: 1 }
    );

    expect(editable.innerText).toBe('/$legacy ');
  });
});
