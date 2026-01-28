import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useInputHistory } from './useInputHistory.js';

const STORAGE_KEY = 'chat-input-history';
const SIMULATED_QUOTA_LIMIT = 180;

function createEditable() {
  const el = document.createElement('div');
  document.body.appendChild(el);

  // JSDOM doesn't fully implement `innerText`; map it to `textContent` for our tests.
  if (typeof (el as unknown as { innerText?: unknown }).innerText === 'undefined') {
    Object.defineProperty(el, 'innerText', {
      get() {
        return this.textContent ?? '';
      },
      set(value: string) {
        this.textContent = value;
      },
      configurable: true,
    });
  }

  return el;
}

function keyEvent(key: string) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function readStored(): string[] {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as string[];
}

describe('useInputHistory', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  it('loads history from localStorage and navigates with ArrowUp/ArrowDown', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['a', 'b', 'c']));
    const editable = createEditable();

    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(true);
    expect(editable.innerText).toBe('c');

    expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(true);
    expect(editable.innerText).toBe('b');

    expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(true);
    expect(editable.innerText).toBe('c');

    expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(true);
    expect(editable.innerText).toBe('');
  });

  it('does not start navigation when input is not empty', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['a']));
    const editable = createEditable();
    editable.innerText = 'hello';

    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(false);
    expect(editable.innerText).toBe('hello');
  });

  it('deduplicates consecutive identical records', () => {
    const editable = createEditable();
    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    result.current.record('same');
    result.current.record('same');

    expect(readStored()).toEqual(['same']);
  });

  it('caps history length to 50 items (keeps newest)', () => {
    const editable = createEditable();
    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    for (let i = 0; i < 60; i++) {
      result.current.record(`m${i}`);
    }

    const stored = readStored();
    expect(stored).toHaveLength(50);
    expect(stored[0]).toBe('m10');
    expect(stored[49]).toBe('m59');
  });

  it('saves and restores draft when navigating history', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['x']));
    const editable = createEditable();
    editable.innerText = '   ';

    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(true);
    expect(editable.innerText).toBe('x');

    expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(true);
    expect(editable.innerText).toBe('   ');
  });

  it('handles localStorage quota by dropping older entries and retrying', () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      const str = String(value);
      if (key === STORAGE_KEY && str.length > SIMULATED_QUOTA_LIMIT) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, key, str);
    });

    const editable = createEditable();
    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    result.current.record('a'.repeat(100));
    result.current.record('b'.repeat(100));
    result.current.record('c'.repeat(100));

    const stored = readStored();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe('c'.repeat(100));
  });

  it('ignores invalid JSON in localStorage', () => {
    window.localStorage.setItem(STORAGE_KEY, '{invalid_json');
    const editable = createEditable();

    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(false);
    expect(editable.innerText).toBe('');
  });

  it('ignores non-array JSON in localStorage', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }));
    const editable = createEditable();

    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(false);
    expect(editable.innerText).toBe('');
  });

  it('handles localStorage being unavailable without crashing', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage unavailable');
      },
    });

    try {
      const editable = createEditable();
      const { result } = renderHook(() =>
        useInputHistory({
          editableRef: { current: editable },
          getTextContent: () => editable.innerText,
          handleInput: vi.fn(),
        })
      );

      expect(() => result.current.record('hello')).not.toThrow();
      expect(() => result.current.handleKeyDown(keyEvent('ArrowUp'))).not.toThrow();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, 'localStorage', originalDescriptor);
      }
    }
  });

  it('resets navigation when other keys are pressed', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['a', 'b']));
    const editable = createEditable();

    const { result } = renderHook(() =>
      useInputHistory({
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        handleInput: vi.fn(),
      })
    );

    expect(result.current.handleKeyDown(keyEvent('ArrowUp'))).toBe(true);
    expect(editable.innerText).toBe('b');

    expect(result.current.handleKeyDown(keyEvent('x'))).toBe(false);
    expect(result.current.handleKeyDown(keyEvent('ArrowDown'))).toBe(false);
  });
});
