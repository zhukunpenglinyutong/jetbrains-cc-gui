import { useTranslation } from 'react-i18next';
import { useGeminiPlanUsage } from '../../../hooks/useGeminiPlanUsage';
import { formatQuotaRemaining, ProviderQuotaPanel, ProviderQuotaRow, type ProviderQuotaPanelAnchor } from './ProviderQuotaPanel';

function displayPercent(remaining: number): number | string {
  // Only an actually depleted bucket should read as 0%, and any sub-1% remainder is still below 1%.
  if (remaining > 0 && remaining < 1) return '<1';
  const rounded = Math.round(remaining);
  if (rounded === 100 && remaining < 100) return '<100';
  return rounded;
}

/** Shows all quota windows returned for the official Antigravity CLI login. */
export function GeminiQuotaSubmenu({ id, anchorRef }: ProviderQuotaPanelAnchor) {
  const { t } = useTranslation();
  const quota = useGeminiPlanUsage();
  let description: string;
  if (quota === null) {
    description = t('config.codexQuota.loading', { defaultValue: 'Loading...' });
  } else if (quota.status === 'ok') {
    description = t('config.codexQuota.lastUpdated', {
      value: new Date(quota.fetchedAt).toLocaleString(),
      defaultValue: 'Updated {{value}}',
    });
  } else {
    switch (quota.reasonCode) {
      case 'cli_missing':
        description = t('config.antigravityQuota.cliMissing');
        break;
      case 'cli_outdated':
        description = t('config.antigravityQuota.cliOutdated', { version: quota.minimumVersion });
        break;
      case 'no_quota':
        description = t('config.antigravityQuota.noQuota');
        break;
      case 'timeout':
        description = t('config.antigravityQuota.timeout');
        break;
      default:
        description = t('config.antigravityQuota.queryFailed');
    }
  }

  return (
    <ProviderQuotaPanel id={id} anchorRef={anchorRef} title={t('config.antigravityQuota.title')} description={description}>
      {quota?.status === 'ok' ? quota.windows.map((window) => (
        <ProviderQuotaRow
          key={window.id}
          label={t(`config.antigravityQuota.buckets.${window.id}`)}
          description={formatQuotaRemaining(t, displayPercent(window.remainingPercent), window.resetsAt)}
        />
      )) : null}
    </ProviderQuotaPanel>
  );
}
