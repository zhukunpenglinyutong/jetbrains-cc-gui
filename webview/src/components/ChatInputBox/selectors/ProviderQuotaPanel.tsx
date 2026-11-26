import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { TFunction } from 'i18next';
import { getAppViewport } from '../../../utils/viewport';

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  alignItems: 'flex-start',
};
const SECTION_STYLE: React.CSSProperties = { padding: '6px 12px' };
const DIVIDER_STYLE: React.CSSProperties = { height: '1px', background: 'var(--dropdown-border)' };

export function formatQuotaRemaining(t: TFunction, percent: number | string, resetsAt?: number | null): string {
  const reset = typeof resetsAt === 'number' ? new Date(resetsAt) : null;
  return reset && Number.isFinite(reset.getTime())
    ? t('config.codexQuota.windowRemainingPercentWithReset', {
        percent,
        value: reset.toLocaleString(),
        defaultValue: '{{percent}}% remaining · Resets {{value}}',
      })
    : t('config.codexQuota.windowRemainingPercent', {
        percent,
        defaultValue: '{{percent}}% remaining',
      });
}

export function ProviderQuotaRow({ label, description }: { label: string; description: string }) {
  return (
    <>
      <div style={DIVIDER_STYLE} />
      <div style={SECTION_STYLE}>
        <div className="selector-option" style={ROW_STYLE}>
          <span>{label}</span>
          <span className="model-description">{description}</span>
        </div>
      </div>
    </>
  );
}

export interface ProviderQuotaPanelAnchor {
  id: string;
  anchorRef: RefObject<HTMLDivElement | null>;
}

interface ProviderQuotaPanelProps extends ProviderQuotaPanelAnchor {
  title: string;
  description: string;
  children?: ReactNode;
}

interface QuotaPanelPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** Quota details stay adjacent to the provider menu without covering its rows. */
export function ProviderQuotaPanel({ id, anchorRef, title, description, children }: ProviderQuotaPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<QuotaPanelPosition | null>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const rect = anchor.getBoundingClientRect();
    const viewport = getAppViewport();
    const scale = viewport.fixedPosDivisor;
    const padding = 8;
    const desiredWidth = Math.min(220 * scale, viewport.width - padding * 2);
    const spaceRight = viewport.left + viewport.width - padding - rect.right;
    const spaceLeft = rect.left - viewport.left - padding;
    const spaceAbove = rect.top - viewport.top - padding;
    const spaceBelow = viewport.top + viewport.height - padding - rect.bottom;
    const sideSpace = Math.max(spaceRight, spaceLeft);
    // A short viewport can use a narrower side panel instead of a tiny top sliver.
    const useSide = sideSpace >= desiredWidth
      || (sideSpace >= 120 * scale && Math.max(spaceAbove, spaceBelow) < 120 * scale);
    const width = Math.max(1, useSide ? Math.min(desiredWidth, sideSpace) : desiredWidth);
    const availableHeight = useSide ? viewport.height - padding * 2 : Math.max(spaceAbove, spaceBelow);
    const maxHeight = Math.max(1, Math.min(300 * scale, availableHeight));
    const height = Math.min(maxHeight, (panel.scrollHeight + 2) * scale);
    const left = useSide
      ? spaceRight >= width ? rect.width : -width
      : Math.max(viewport.left + padding - rect.left,
        Math.min(0, viewport.left + viewport.width - padding - rect.left - width));
    const top = useSide
      ? Math.max(viewport.top + padding - rect.top,
        Math.min(0, viewport.top + viewport.height - padding - rect.top - height))
      : spaceAbove >= spaceBelow ? -height : rect.height;
    // Absolute offsets start inside the anchor border; leaving that border unaccounted for opens a mouseout gap.
    const next = {
      left: left / scale - anchor.clientLeft,
      top: top / scale - anchor.clientTop,
      width: width / scale,
      maxHeight: maxHeight / scale,
    };
    setPosition((current) => current
      && current.left === next.left && current.top === next.top
      && current.width === next.width && current.maxHeight === next.maxHeight
      ? current : next);
  }, [anchorRef]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition, title, description, children, position?.width]);

  useEffect(() => {
    window.addEventListener('resize', reposition);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (panelRef.current) observer?.observe(panelRef.current);
    return () => {
      window.removeEventListener('resize', reposition);
      observer?.disconnect();
    };
  }, [anchorRef, reposition]);

  return (
    <div
      id={id}
      ref={panelRef}
      role="region"
      aria-label={title}
      tabIndex={-1}
      className="selector-dropdown provider-quota-panel"
      style={{ position: 'absolute', zIndex: 10001, ...position }}
      onKeyDown={(event) => {
        if (event.key === 'Home') {
          event.currentTarget.scrollTop = 0;
        } else if (event.key === 'End') {
          event.currentTarget.scrollTop = event.currentTarget.scrollHeight;
        }
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="selector-option disabled" style={{ cursor: 'default' }}>
        <span className="codicon codicon-dashboard" />
        <div style={ROW_STYLE}>
          <span>{title}</span>
          <span className="model-description" aria-live="polite">{description}</span>
        </div>
      </div>
      {children}
    </div>
  );
}
