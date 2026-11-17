import { lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';

import { TokenTrackerServerGate } from './TokenTrackerServerGate';
import type { TokenTrackerGateCopy } from './TokenTrackerServerGate';

// 整个 vendored dashboard（含 motion / @base-ui 依赖）隔离在异步 chunk
//（单文件构建下仍内联，但保持懒加载语义与 desktop 侧结构一致）。
const LazyTokenTrackerDashboard = lazy(() => import('./TokenTrackerDashboardView'));

export function UsageDashboardSection() {
  const { t } = useTranslation();

  const copy: TokenTrackerGateCopy = {
    checkingLabel: t('usage.checkingLabel'),
    installingLabel: t('usage.installingLabel'),
    installingDesc: t('usage.installingDesc'),
    startingLabel: t('usage.startingLabel'),
    guideTitle: t('usage.guideTitle'),
    guideDesc: t('usage.guideDesc'),
    guideInstallLabel: t('usage.guideInstallLabel'),
    guideCopy: t('usage.guideCopy'),
    guideCopied: t('usage.guideCopied'),
    guideInstallNow: t('usage.guideInstallNow'),
    guideNoteHooks: t('usage.guideNoteHooks'),
    guideNoteTelemetry: t('usage.guideNoteTelemetry'),
    errorTitle: t('usage.errorTitle'),
    errorRetry: t('usage.errorRetry'),
  };

  return (
    <TokenTrackerServerGate
      icon={BarChart3}
      copy={copy}
      dashboardClassName="extensions-usage-dashboard"
    >
      <LazyTokenTrackerDashboard />
    </TokenTrackerServerGate>
  );
}
