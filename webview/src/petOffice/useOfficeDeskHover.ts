import { useCallback, useEffect, useRef, useState } from 'react';

export interface OfficeDeskHover { sourceKey: string; x: number; y: number }

/** Pointer movement stays outside React; only a changed, settled desk opens a preview. */
export function useOfficeDeskHover() {
  const [preview, setPreview] = useState<OfficeDeskHover | null>(null);
  const candidate = useRef<OfficeDeskHover | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismiss = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null; candidate.current = null; setPreview(value => value === null ? value : null);
  }, []);
  const inspect = useCallback((sourceKey: string | null, x: number, y: number) => {
    if ((candidate.current?.sourceKey ?? null) === sourceKey) return;
    dismiss();
    if (!sourceKey) return;
    candidate.current = { sourceKey, x, y };
    timer.current = setTimeout(() => { timer.current = null; setPreview(candidate.current); }, 240);
  }, [dismiss]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, { capture: true, passive: true });
    document.addEventListener('visibilitychange', dismiss); document.addEventListener('keydown', key);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('visibilitychange', dismiss); document.removeEventListener('keydown', key);
    };
  }, [dismiss]);
  return { preview, inspect, dismiss };
}
