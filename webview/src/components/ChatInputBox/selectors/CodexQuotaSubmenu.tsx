import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchCodexSubscriptionQuota,
  subscribeCodexSubscriptionQuota,
  type CodexSubscriptionQuotaSnapshot,
  type CodexSubscriptionQuotaWindow,
} from '../../../utils/codexSubscriptionQuotaCapabilities';
import { formatQuotaRemaining, ProviderQuotaPanel, ProviderQuotaRow, type ProviderQuotaPanelAnchor } from './ProviderQuotaPanel';

/** Codex subscription quota panel. */
export const CodexQuotaSubmenu = ({ id, anchorRef }: ProviderQuotaPanelAnchor) => {
  const { t } = useTranslation();
  const [quota, setQuota] = useState<CodexSubscriptionQuotaSnapshot | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeCodexSubscriptionQuota(setQuota);
    fetchCodexSubscriptionQuota();
    return unsubscribe;
  }, []);

  // API-key providers are billed per token and have no subscription quota.
  const isApiKeyMode = quota?.reasonCode === 'api_key_mode';
  const describeWindow = (window: CodexSubscriptionQuotaWindow | undefined) => {
    const limit = window?.limitTokens;
    const remaining = window?.remainingTokens;
    const percent = window?.remainingPercent;
    const ratio = typeof percent === 'number' && Number.isFinite(percent) ? percent
      : typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        && typeof remaining === 'number' && Number.isFinite(remaining) ? remaining / limit * 100 : null;
    if (ratio !== null) {
      return formatQuotaRemaining(t, Math.max(0, Math.min(100, Math.round(ratio))), window?.resetsAt);
    }
    if (window && Number.isFinite(window.usedTokens) && window.usedTokens > 0) {
      return t('config.codexQuota.windowUsedOnly', {
        used: Math.trunc(window.usedTokens).toLocaleString(),
        defaultValue: '{{used}} used',
      });
    }
    return t('config.codexQuota.windowUnavailable', { defaultValue: 'Unavailable' });
  };

  const description = isApiKeyMode
    ? t('config.codexQuota.apiKeyMode', { defaultValue: 'API key mode has no subscription quota' })
    : quota?.status === 'ok'
      ? t('config.codexQuota.lastUpdated', {
          value: new Date(quota.fetchedAt).toLocaleString(),
          defaultValue: 'Updated {{value}}',
        })
      : quota === null
        ? t('config.codexQuota.loading', { defaultValue: 'Loading...' })
        : t('config.codexQuota.unavailable', { defaultValue: 'Unavailable' });

  return (
    <ProviderQuotaPanel
      id={id}
      anchorRef={anchorRef}
      title={t('config.codexQuota.title', { defaultValue: 'Codex quota' })}
      description={description}
    >
      {isApiKeyMode ? null : (
        <>
          <ProviderQuotaRow label={t('config.codexQuota.fiveHour', { defaultValue: '5h usage' })} description={describeWindow(quota?.windows.fiveHour)} />
          <ProviderQuotaRow label={t('config.codexQuota.weekly', { defaultValue: 'Weekly usage' })} description={describeWindow(quota?.windows.weekly)} />
        </>
      )}
    </ProviderQuotaPanel>
  );
};

export default CodexQuotaSubmenu;
