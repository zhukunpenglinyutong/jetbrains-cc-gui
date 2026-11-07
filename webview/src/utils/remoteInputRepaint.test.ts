import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRemoteInputRepaint } from './remoteInputRepaint';

describe('remote input surface repaint', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const frame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  };
  const editor = () => {
    document.body.innerHTML = '<div id="app" style="zoom:1"><div class="input-editable" contenteditable="true" tabindex="0" style="color:rgb(204,204,204);background:rgb(30,30,30)">中文 English</div></div>';
    const el = document.querySelector<HTMLElement>('.input-editable')!;
    vi.spyOn(el, 'getBoundingClientRect');
    // happy-dom rejects color-mix. Chromium E2E covers the real CSS in both themes;
    // model an accepted color here to test ownership, scheduling and restoration.
    const setProperty = el.style.setProperty.bind(el.style);
    vi.spyOn(el.style, 'setProperty').mockImplementation((name, value, priority) => {
      setProperty(name, value?.startsWith('color-mix(') ? 'rgb(33, 33, 33)' : value, priority);
    });
    el.focus();
    return el;
  };

  it('repaints the backing without changing content, focus, selection or geometry during composition', () => {
    const el = editor();
    const range = document.createRange();
    range.setStart(el.firstChild!, 1);
    range.setEnd(el.firstChild!, 4);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const original = el.style.backgroundColor;
    const html = el.innerHTML;
    stop = installRemoteInputRepaint();
    el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true }));
    frame();

    expect(el.style.backgroundColor).toBe('rgb(33, 33, 33)');
    expect(el.style.getPropertyPriority('background-color')).toBe('important');
    expect(el.innerHTML).toBe(html);
    expect(document.activeElement).toBe(el);
    expect(getSelection()!.getRangeAt(0)).toBe(range);
    expect([range.startOffset, range.endOffset]).toEqual([1, 4]);
    expect(document.getElementById('app')!.style.zoom).toBe('1');
    expect(el.getBoundingClientRect).not.toHaveBeenCalled();
    frame();
    expect(el.style.backgroundColor).toBe(original);
    expect(el.style.getPropertyPriority('background-color')).toBe('');
  });

  it('coalesces activation and event bursts and does no work while idle', () => {
    const el = editor();
    stop = installRemoteInputRepaint();
    expect(installRemoteInputRepaint()).toBe(stop);
    for (let i = 0; i < 100; i++) el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(frames.size).toBe(1);
    const set = vi.spyOn(el.style, 'setProperty');
    frame();
    expect(set).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(frames.size).toBe(1);
    frame();
    const writes = set.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(frames.size).toBe(0);
    expect(set).toHaveBeenCalledTimes(writes);
    expect(el.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('repaints deletion to empty and caret moves without adding editor nodes', () => {
    const el = editor();
    stop = installRemoteInputRepaint();
    frame();
    frame();
    el.textContent = '';
    el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
    frame();
    expect(el.style.backgroundColor).toBe('rgb(33, 33, 33)');
    expect(el.childNodes).toHaveLength(0);
    frame();
    getSelection()!.selectAllChildren(el);
    document.dispatchEvent(new Event('selectionchange'));
    expect(frames.size).toBe(1);
  });

  it('uses the newly focused editor if React replaces it before the scheduled frame', () => {
    const old = editor();
    const original = old.style.backgroundColor;
    stop = installRemoteInputRepaint();
    const replacement = editor();
    frame();
    expect(old.style.backgroundColor).toBe(original);
    expect(replacement.style.backgroundColor).toBe('rgb(33, 33, 33)');
    expect(document.activeElement).toBe(replacement);
  });

  it('restores the background if animation frames stop and cancels the pending callback', () => {
    const el = editor();
    el.style.setProperty('background-color', 'rgb(20, 20, 20)', 'important');
    stop = installRemoteInputRepaint();
    frame();
    expect(el.style.backgroundColor).toBe('rgb(33, 33, 33)');
    vi.advanceTimersByTime(150);
    expect(el.style.backgroundColor).toBe('rgb(20, 20, 20)');
    expect(el.style.getPropertyPriority('background-color')).toBe('important');
    expect(frames.size).toBe(0);
  });

  it('preserves a newer external background update when the pulse ends', () => {
    const el = editor();
    stop = installRemoteInputRepaint();
    frame();
    el.style.setProperty('background-color', 'rgb(240, 240, 240)');
    frame();
    expect(el.style.backgroundColor).toBe('rgb(240, 240, 240)');
    expect(el.style.getPropertyPriority('background-color')).toBe('');
  });

  it('cleans up on pagehide and keeps an old cleanup from retiring a new installation', () => {
    const el = editor();
    const oldStop = installRemoteInputRepaint();
    window.dispatchEvent(new Event('pagehide'));
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(frames.size).toBe(0);
    stop = installRemoteInputRepaint();
    oldStop();
    frame();
    expect(el.style.backgroundColor).toBe('rgb(33, 33, 33)');
    frame();
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(frames.size).toBe(1);
  });

  it('skips hidden, unfocused and unrelated controls, and releases a hidden page pulse', () => {
    const el = editor();
    const original = el.style.backgroundColor;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    stop = installRemoteInputRepaint();
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(frames.size).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    frame();
    expect(el.style.backgroundColor).toBe('rgb(33, 33, 33)');
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(el.style.backgroundColor).toBe(original);
    expect(frames.size).toBe(0);
    hidden.mockReturnValue(false);
    document.body.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(frames.size).toBe(0);
    el.blur();
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(frames.size).toBe(0);
  });
});
