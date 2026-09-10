import { useTranslation } from 'react-i18next';
import type { CodexSubscriptionQuotaSnapshot } from '../../../utils/codexSubscriptionQuotaCapabilities';

const SUBMENU_STYLE: React.CSSProperties = {
  // Float the quota panel above the whole dropdown (full-width, never overlapping rows).
  position: 'absolute',
  left: 0,
  right: 0,
  zIndex: 10001,
  whiteSpace: 'normal',
};
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
  quota: CodexSubscriptionQuotaSnapshot | null;
  loading: boolean;
  /** Distance (px) from the Codex row's bottom edge up to the floating quota panel. */
  bottom: number;
  onHover: () => void;
}

/**
 * CodexQuotaSubmenu - floating Codex subscription quota panel
 * Hovers above the provider dropdown when the Codex row is hovered.
 */
export const CodexQuotaSubmenu = ({ quota, loading, bottom, onHover }: CodexQuotaSubmenuProps) => {
  const { t } = useTranslation();
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
      className="selector-dropdown"
      style={{ ...SUBMENU_STYLE, bottom: `${bottom}px` }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={(e) => {
        e.stopPropagation();
        onHover();
      }}
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
