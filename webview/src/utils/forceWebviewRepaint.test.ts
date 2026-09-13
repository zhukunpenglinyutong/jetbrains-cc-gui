import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forceWebviewRepaint } from './forceWebviewRepaint';
import {
  advanceSurfaceDamagePulse,
  beginSurfaceDamagePulse,
  cancelSurfaceDamagePulse,
  finishSurfaceDamagePulse,
} from './surfaceDamagePulse';

describe('forceWebviewRepaint', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let fontScale = '1.1';

  beforeEach(() => {
    vi.useFakeTimers();
    rafQueue = [];
    fontScale = '1.1';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => fontScale,
    }) as unknown as CSSStyleDeclaration);
  });

  afterEach(() => {
    cancelSurfaceDamagePulse('strict-attempt');
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Drain the queued rAF callbacks (the util uses a double rAF). */
  const flushRaf = () => {
    while (rafQueue.length > 0) {
      const cb = rafQueue.shift()!;
      cb(0);
    }
  };

  it('toggles inline zoom and dispatches resize after a double rAF', () => {
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? ''; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;

    vi.spyOn(document, 'getElementById').mockImplementation((id) => (
      id === 'app' ? app : document.querySelector(`#${id}`)
    ));
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);

    forceWebviewRepaint('unit-test');

    // The nudge is deferred until React finishes its unmount/reflow (double rAF).
    expect(zoomWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();

    flushRaf();

    // zoom is forced to '1' then restored to the --font-scale value, forcing
    // Chromium/JCEF to re-rasterize the whole viewport.
    expect(zoomWrites).toEqual(['1.0989', '1.1']);
    const resizeDispatched = dispatchSpy.mock.calls.some(
      ([evt]) => evt instanceof Event && evt.type === 'resize'
    );
    expect(resizeDispatched).toBe(true);
  });

  it('invokes the completion callback once after repaint instead of when scheduled', () => {
    const app = {
      style: { zoom: '' },
      offsetHeight: 0,
    } as unknown as HTMLElement;
    const onRepaint = vi.fn();

    vi.spyOn(document, 'getElementById').mockReturnValue(app);
    forceWebviewRepaint('history-render-complete', onRepaint);

    expect(onRepaint).not.toHaveBeenCalled();
    flushRaf();
    expect(onRepaint).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    expect(onRepaint).toHaveBeenCalledTimes(1);
  });

  it('is a no-op and does not throw when #app is missing', () => {
    vi.spyOn(document, 'getElementById').mockReturnValue(null);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    expect(() => {
      forceWebviewRepaint();
      flushRaf();
    }).not.toThrow();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('uses a timer fallback when JCEF does not deliver animation frames', () => {
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? ''; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;

    vi.spyOn(document, 'getElementById').mockReturnValue(app);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);

    forceWebviewRepaint('tab-activated');
    vi.advanceTimersByTime(50);

    expect(zoomWrites).toEqual(['1.0989', '1.1']);
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }));
  });

  it('uses a distinct zoom nudge for repeated repaints at 100 percent scale', () => {
    fontScale = '1';
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? '1'; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;

    vi.spyOn(document, 'getElementById').mockReturnValue(app);

    forceWebviewRepaint('first-activation');
    flushRaf();
    forceWebviewRepaint('second-activation');
    flushRaf();

    expect(zoomWrites).toEqual(['0.999', '1', '0.999', '1']);
  });

  it('coalesces generic repaints until a strict two-frame pulse has finished', async () => {
    fontScale = '1';
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? ''; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    vi.spyOn(document, 'getElementById').mockImplementation((id) => (
      id === 'app' ? app : document.querySelector(`#${id}`)
    ));

    expect(beginSurfaceDamagePulse('strict-attempt')).toBe(true);
    forceWebviewRepaint('dialog-close', firstCallback);
    forceWebviewRepaint('tab-activated', secondCallback);
    expect(zoomWrites).toEqual([]);

    expect(advanceSurfaceDamagePulse('strict-attempt')).toBe(true);
    expect(finishSurfaceDamagePulse('strict-attempt')).toBe(true);
    await Promise.resolve();
    flushRaf();

    expect(zoomWrites).toEqual(['0.999', '1']);
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledTimes(1);
  });

  it('rechecks ownership when a pulse begins after generic repaint scheduling', async () => {
    fontScale = '1';
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? ''; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;
    vi.spyOn(document, 'getElementById').mockImplementation((id) => (
      id === 'app' ? app : document.querySelector(`#${id}`)
    ));

    forceWebviewRepaint('scheduled-before-pulse');
    expect(beginSurfaceDamagePulse('strict-attempt')).toBe(true);
    flushRaf();
    vi.advanceTimersByTime(50);

    expect(zoomWrites).toEqual([]);
    expect(advanceSurfaceDamagePulse('strict-attempt')).toBe(true);
    expect(finishSurfaceDamagePulse('strict-attempt')).toBe(true);
    await Promise.resolve();

    expect(zoomWrites).toEqual(['0.999', '1']);
  });
});
