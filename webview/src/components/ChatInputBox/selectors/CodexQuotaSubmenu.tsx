import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchCodexSubscriptionQuota,
  subscribeCodexSubscriptionQuota,
  type CodexSubscriptionQuotaSnapshot,
} from '../../../utils/codexSubscriptionQuotaCapabilities';
import { getAppViewport } from '../../../utils/viewport';

const SUBMENU_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  alignItems: 'flex-start',
};
const SUBMENU_SECTION_STYLE: React.CSSProperties = {
  padding: '6px 12px',
};
const SUBMENU_DIVIDER_STYLE: React.CSSProperties = {
  height: '1px',
  background: 'var(--dropdown-border)',
};

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.trunc(value).toLocaleString();
}

interface CodexQuotaSubmenuProps {
  id: string;
  anchorRef: RefObject<HTMLDivElement | null>;
}

interface QuotaPanelPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/**
 * CodexQuotaSubmenu - Codex subscription quota panel.
 */
export const CodexQuotaSubmenu = ({ id, anchorRef }: CodexQuotaSubmenuProps) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [quota, setQuota] = useState<CodexSubscriptionQuotaSnapshot | null>(null);
  const [position, setPosition] = useState<QuotaPanelPosition | null>(null);
  const loading = quota === null;

  useEffect(() => {
    const unsubscribe = subscribeCodexSubscriptionQuota(setQuota);
    fetchCodexSubscriptionQuota();
    return unsubscribe;
  }, []);

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
    // Unlike actionable submenus, quota details must never cover provider rows.
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
    const next = { left: left / scale, top: top / scale, width: width / scale, maxHeight: maxHeight / scale };
    setPosition((current) => current
      && current.left === next.left && current.top === next.top
      && current.width === next.width && current.maxHeight === next.maxHeight
      ? current : next);
  }, [anchorRef]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition, quota, t, position?.width]);

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

  const fiveHour = quota?.windows.fiveHour;
  const weekly = quota?.windows.weekly;
  // API-key providers are billed per token and have no subscription quota,
  // so the window rows would only ever show "Unavailable" noise.
  const isApiKeyMode = quota?.reasonCode === 'api_key_mode';

  const renderWindowRow = (
    label: string,
    window: CodexSubscriptionQuotaSnapshot['windows']['fiveHour'] | undefined,
    isLast: boolean,
  ) => {
    const hasLimit = typeof window?.limitTokens === 'number' && Number.isFinite(window.limitTokens);
    const hasRemaining = typeof window?.remainingTokens === 'number' && Number.isFinite(window.remainingTokens);
    const limitTokens = typeof window?.limitTokens === 'number' ? window.limitTokens : undefined;
    const remainingTokens = typeof window?.remainingTokens === 'number' ? window.remainingTokens : undefined;
    const remainingPercentFromApi = typeof window?.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
      ? window.remainingPercent
      : null;
    const remainingPercent = remainingPercentFromApi !== null
      ? Math.max(0, Math.min(100, Math.round(remainingPercentFromApi)))
      : hasLimit && hasRemaining && (limitTokens ?? 0) > 0
        ? Math.max(0, Math.min(100, Math.round(((remainingTokens ?? 0) / (limitTokens ?? 1)) * 100)))
        : null;
    const hasUsedTokens = typeof window?.usedTokens === 'number' && Number.isFinite(window.usedTokens) && window.usedTokens > 0;
    const resetsAt = typeof window?.resetsAt === 'number' && Number.isFinite(window.resetsAt)
      ? new Date(window.resetsAt).toLocaleString()
      : null;
    return (
      <div style={SUBMENU_SECTION_STYLE}>
        <div className="selector-option" style={SUBMENU_ROW_STYLE}>
          <span>{label}</span>
          <span className="model-description">
            {window
              ? remainingPercent !== null
                ? resetsAt
                  ? t('config.codexQuota.windowRemainingPercentWithReset', {
                      percent: remainingPercent,
                      value: resetsAt,
                      defaultValue: '{{percent}}% remaining · Resets {{value}}',
                    })
                  : t('config.codexQuota.windowRemainingPercent', {
                    percent: remainingPercent,
                    defaultValue: '{{percent}}% remaining',
                  })
                : hasUsedTokens
                  ? t('config.codexQuota.windowUsedOnly', {
                    used: formatTokens(window.usedTokens),
                    defaultValue: '{{used}} used',
                  })
                  : t('config.codexQuota.windowUnavailable', { defaultValue: 'Unavailable' })
              : t('config.codexQuota.windowUnavailable', { defaultValue: 'Unavailable' })}
          </span>
        </div>
        {!isLast && <div style={SUBMENU_DIVIDER_STYLE} />}
      </div>
    );
  };

  return (
    <div
      id={id}
      ref={panelRef}
      role="tooltip"
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
      onClick={(e) => e.stopPropagation()}
    >
      <div className="selector-option disabled" style={{ cursor: 'default' }}>
        <span className="codicon codicon-dashboard" />
        <div style={SUBMENU_ROW_STYLE}>
          <span>{t('config.codexQuota.title', { defaultValue: 'Codex quota' })}</span>
          <span className="model-description">
            {isApiKeyMode
              ? t('config.codexQuota.apiKeyMode', { defaultValue: 'API key mode has no subscription quota' })
              : quota?.status === 'ok'
                ? t('config.codexQuota.lastUpdated', {
                    value: new Date(quota.fetchedAt).toLocaleString(),
                    defaultValue: 'Updated {{value}}',
                  })
                : loading
                  ? t('config.codexQuota.loading', { defaultValue: 'Loading...' })
                  : t('config.codexQuota.unavailable', { defaultValue: 'Unavailable' })}
            </span>
        </div>
      </div>
      {!isApiKeyMode && (
        <>
          <div style={SUBMENU_DIVIDER_STYLE} />
          {renderWindowRow(t('config.codexQuota.fiveHour', { defaultValue: '5h usage' }), fiveHour, false)}
          {renderWindowRow(t('config.codexQuota.weekly', { defaultValue: 'Weekly usage' }), weekly, true)}
        </>
      )}
    </div>
  );
};

export default CodexQuotaSubmenu;
