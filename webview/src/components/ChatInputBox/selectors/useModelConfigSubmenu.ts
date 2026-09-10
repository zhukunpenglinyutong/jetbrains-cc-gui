import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Delay before switching an already-open fly-out. The effort fly-out sits
 * beside its row, so the pointer may cross the 1M context / speed / preset
 * rows on the way; without a grace period those rows steal the submenu.
 */
export const SUBMENU_HOVER_DELAY_MS = 200;
/**
 * Delay before opening the first fly-out on hover. The function rows sit at
 * the popover's bottom edge — right where the pointer enters from the
 * trigger — so an instant open would fire on every pass-through.
 */
export const SUBMENU_TRIGGER_DELAY_MS = 500;

export type ActiveSubmenu = 'none' | 'effort' | 'speed' | 'preset';

/**
 * Hover state machine behind the model-config fly-out submenus: which
 * submenu is open, the per-row trigger refs, and the delayed open/switch
 * scheduling that keeps pass-through pointer movement from stealing the
 * already-open fly-out.
 */
export const useModelConfigSubmenu = () => {
  const [activeSubmenu, setActiveSubmenu] = useState<ActiveSubmenu>('none');
  const activeSubmenuRef = useRef<ActiveSubmenu>(activeSubmenu);
  useEffect(() => {
    activeSubmenuRef.current = activeSubmenu;
  }, [activeSubmenu]);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const effortTriggerRef = useRef<HTMLDivElement>(null);
  const speedTriggerRef = useRef<HTMLDivElement>(null);
  const presetTriggerRef = useRef<HTMLDivElement>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);

  const openSubmenu = useCallback((submenu: ActiveSubmenu) => {
    clearHoverTimer();
    setActiveSubmenu(submenu);
  }, [clearHoverTimer]);

  const scheduleSubmenu = useCallback((submenu: ActiveSubmenu) => {
    if (activeSubmenuRef.current === submenu) {
      clearHoverTimer();
      return;
    }
    clearHoverTimer();
    // Opening the first fly-out waits longer than switching between open
    // fly-outs: the pointer may only be crossing a row on its way elsewhere.
    const delay = activeSubmenuRef.current === 'none'
      ? SUBMENU_TRIGGER_DELAY_MS
      : SUBMENU_HOVER_DELAY_MS;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      setActiveSubmenu(submenu);
    }, delay);
  }, [clearHoverTimer]);

  const triggerRefFor = (submenu: ActiveSubmenu) => {
    if (submenu === 'preset') return presetTriggerRef.current;
    if (submenu === 'effort') return effortTriggerRef.current;
    if (submenu === 'speed') return speedTriggerRef.current;
    return null;
  };

  /**
   * Fly-outs stop mouseenter from bubbling. If the pointer crossed another
   * row on the way, that row armed a delayed switch — arriving inside the
   * already-open fly-out must cancel it.
   */
  const retainActiveSubmenu = useCallback((event: React.MouseEvent) => {
    const current = activeSubmenuRef.current;
    if (current === 'none') return;
    const trigger = triggerRefFor(current);
    if (trigger?.contains(event.target as Node)) {
      clearHoverTimer();
    }
  }, [clearHoverTimer]);

  const resetSubmenu = useCallback(() => {
    clearHoverTimer();
    setActiveSubmenu('none');
  }, [clearHoverTimer]);

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  return {
    activeSubmenu,
    effortTriggerRef,
    speedTriggerRef,
    presetTriggerRef,
    openSubmenu,
    scheduleSubmenu,
    retainActiveSubmenu,
    resetSubmenu,
  };
};
