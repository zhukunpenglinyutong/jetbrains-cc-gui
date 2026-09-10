import type { TFunction } from 'i18next';

/**
 * SdkStatusBar - SDK status warning bar
 * Displays SDK status loading, query error, or not installed warning bar
 */
export const SdkStatusBar = ({
  sdkStatusLoading,
  sdkStatusError,
  sdkInstalled,
  currentProvider,
  onRetrySdkStatus,
  onInstallSdk,
  t,
}: {
  sdkStatusLoading: boolean;
  sdkStatusError: boolean;
  sdkInstalled: boolean;
  currentProvider: string;
  onRetrySdkStatus?: () => void;
  onInstallSdk?: () => void;
  t: TFunction;
}) => {
  if (!(sdkStatusLoading || sdkStatusError || !sdkInstalled)) {
    return null;
  }

  return (
    <div className={`sdk-warning-bar ${sdkStatusLoading ? 'sdk-loading' : ''}`}>
      <span
        className={`codicon ${sdkStatusLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-warning'}`}
      />
      <span className="sdk-warning-text">
        {sdkStatusLoading
          ? t('chat.sdkStatusLoading')
          : sdkStatusError
            ? t('chat.sdkStatusUnavailable')
          : t('chat.sdkNotInstalled', {
              provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code',
            })}
      </span>
      {sdkStatusError ? (
        <button
          className="sdk-install-btn"
          onClick={(e) => {
            e.stopPropagation();
            onRetrySdkStatus?.();
          }}
        >
          <span className="codicon codicon-refresh" />
          <span>{t('chat.retrySdkStatus')}</span>
        </button>
      ) : !sdkStatusLoading && (
        <button
          className="sdk-install-btn"
          onClick={(e) => {
            e.stopPropagation();
            onInstallSdk?.();
          }}
        >
          {t('chat.goInstallSdk')}
        </button>
      )}
    </div>
  );
};

export default SdkStatusBar;
