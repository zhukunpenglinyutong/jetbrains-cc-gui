import { memo } from 'react';
import type { TFunction } from 'i18next';

interface ProviderNotConfiguredCardProps {
  t: TFunction;
  onNavigateToSettings?: () => void;
}

const SettingsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

const ArrowRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 12h14m-7-7 7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ProviderNotConfiguredCard = memo(function ProviderNotConfiguredCard({
  t,
  onNavigateToSettings,
}: ProviderNotConfiguredCardProps) {
  return (
    <div className="provider-not-configured-card">
      <div className="provider-card-header">
        <span className="provider-card-icon">
          <SettingsIcon />
        </span>
        <span className="provider-card-title">
          {t('error.providerNotConfigured')}
        </span>
      </div>
      <p className="provider-card-description">
        {t('error.providerNotConfiguredDesc')}
      </p>
      {onNavigateToSettings && (
        <button
          type="button"
          className="provider-card-action"
          onClick={onNavigateToSettings}
        >
          {t('error.goToProviderSettings')}
          <ArrowRightIcon />
        </button>
      )}
    </div>
  );
});
