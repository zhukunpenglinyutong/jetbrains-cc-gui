import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceSurfaceDamagePulse,
  beginSurfaceDamagePulse,
  cancelSurfaceDamagePulse,
  finishSurfaceDamagePulse,
  replaceSurfaceDamagePulse,
  runAfterSurfaceDamagePulse,
} from './surfaceDamagePulse';

describe('surfaceDamagePulse', () => {
  const tokens = ['attempt-a', 'attempt-b'];
  let bridgeMessages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app" style="zoom: 1.4"></div>';
    bridgeMessages = vi.fn();
    window.sendToJava = bridgeMessages;
  });

  afterEach(() => {
    tokens.forEach((token) => cancelSurfaceDamagePulse(token));
    document.body.innerHTML = '';
    delete window.sendToJava;
    vi.restoreAllMocks();
  });

  it('acknowledges sentinel mutations without changing app zoom', () => {
    const app = document.getElementById('app') as HTMLElement;

    expect(beginSurfaceDamagePulse('attempt-a')).toBe(true);
    const sentinel = document.getElementById('ccgui-surface-damage-sentinel');
    expect(sentinel).not.toBeNull();
    expect(sentinel?.parentElement).toBe(document.body);
    expect(app.contains(sentinel)).toBe(false);
    expect(sentinel?.style.position).toBe('fixed');
    expect(sentinel?.style.pointerEvents).toBe('none');
    expect(sentinel?.style.contain).toBe('strict');
    expect(sentinel?.style.backgroundColor).not.toBe('transparent');
    expect(app.style.zoom).toBe('1.4');
    expect(bridgeMessages).toHaveBeenLastCalledWith(
      'surface_damage_applied:{"token":"attempt-a","phase":"A","applied":true}',
    );

    expect(advanceSurfaceDamagePulse('attempt-a')).toBe(true);
    expect(sentinel?.style.backgroundColor).toBe('transparent');
    expect(app.style.zoom).toBe('1.4');
    expect(bridgeMessages).toHaveBeenLastCalledWith(
      'surface_damage_applied:{"token":"attempt-a","phase":"B","applied":true}',
    );

    expect(finishSurfaceDamagePulse('attempt-a')).toBe(true);
    expect(document.getElementById('ccgui-surface-damage-sentinel')).toBeNull();
  });

  it('rejects stale phase requests without mutating the active sentinel', () => {
    expect(beginSurfaceDamagePulse('attempt-a')).toBe(true);
    const sentinel = document.getElementById('ccgui-surface-damage-sentinel');
    const phaseAColor = sentinel?.style.backgroundColor;

    expect(advanceSurfaceDamagePulse('attempt-b')).toBe(false);
    expect(sentinel?.style.backgroundColor).toBe(phaseAColor);
    expect(bridgeMessages).toHaveBeenLastCalledWith(
      'surface_damage_applied:{"token":"attempt-b","phase":"B","applied":false}',
    );
  });

  it('removes the sentinel when a phase-A attempt is cancelled', () => {
    expect(beginSurfaceDamagePulse('attempt-a')).toBe(true);

    expect(cancelSurfaceDamagePulse('attempt-a')).toBe(true);
    expect(document.getElementById('ccgui-surface-damage-sentinel')).toBeNull();
    expect((document.getElementById('app') as HTMLElement).style.zoom).toBe('1.4');
  });

  it('replaces the exact owner with a different raster variant without releasing waiters', async () => {
    const deferred = vi.fn();
    expect(beginSurfaceDamagePulse('attempt-a')).toBe(true);
    const sentinel = document.getElementById('ccgui-surface-damage-sentinel');
    const firstColor = sentinel?.style.backgroundColor;
    expect(runAfterSurfaceDamagePulse(deferred)).toBe(true);

    expect(replaceSurfaceDamagePulse('attempt-a', 'attempt-b')).toBe(true);
    await Promise.resolve();

    expect(sentinel?.style.backgroundColor).not.toBe(firstColor);
    expect(deferred).not.toHaveBeenCalled();
    expect(bridgeMessages).toHaveBeenLastCalledWith(
      'surface_damage_applied:{"token":"attempt-b","phase":"A","applied":true}',
    );
    expect(cancelSurfaceDamagePulse('attempt-b')).toBe(true);
    await Promise.resolve();
    expect(deferred).toHaveBeenCalledTimes(1);
    expect(document.getElementById('ccgui-surface-damage-sentinel')).toBeNull();
  });

  it('rejects replacement when the declared predecessor does not own the sentinel', () => {
    expect(beginSurfaceDamagePulse('attempt-a')).toBe(true);
    const sentinel = document.getElementById('ccgui-surface-damage-sentinel');
    const phaseAColor = sentinel?.style.backgroundColor;

    expect(replaceSurfaceDamagePulse('stale-attempt', 'attempt-b')).toBe(false);
    expect(sentinel?.style.backgroundColor).toBe(phaseAColor);
    expect(bridgeMessages).toHaveBeenLastCalledWith(
      'surface_damage_applied:{"token":"attempt-b","phase":"A","applied":false}',
    );
  });
});
