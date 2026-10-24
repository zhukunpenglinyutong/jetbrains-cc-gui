import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import { OFFICE_SCENE_WIDTH } from './officeRenderer';

/** Fit the logical room into the actual viewport; zoom adds deliberate, local scrolling. */
export function fitOfficeSceneWidth(width: number, height: number, sceneHeight: number, sceneWidth = OFFICE_SCENE_WIDTH): number {
  if (![width, height, sceneHeight, sceneWidth].every(value => Number.isFinite(value) && value > 0)) return 1;
  return Math.max(1, Math.floor(Math.min(width, height * sceneWidth / sceneHeight)));
}

export function useOfficeViewport(ref: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 1160, height: 700 });
  useLayoutEffect(() => {
    const viewport = ref.current;
    if (!viewport) return;
    const resize = () => setSize(previous => {
      const next = { width: Math.max(1, viewport.clientWidth), height: Math.max(1, viewport.clientHeight) };
      return next.width === previous.width && next.height === previous.height ? previous : next;
    });
    const observer = new ResizeObserver(resize); observer.observe(viewport); resize();
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
