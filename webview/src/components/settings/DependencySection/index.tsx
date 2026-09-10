import {
  SDK_DEFINITIONS,
  useDependencySection,
  type DependencySectionProps,
} from './useDependencySection';
import SdkCard from './SdkCard';
import ListStatus from './ListStatus';
import InstallLogs from './InstallLogs';
import styles from './style.module.less';

const DependencySection = ({ addToast, isActive }: DependencySectionProps) => {
  const {
    t,
    loading,
    statusError,
    installingSdk,
    uninstallingSdk,
    updatingSdk,
    installLogs,
    showLogs,
    setShowLogs,
    nodeAvailable,
    sdkStatus,
    sdkVersions,
    selectedVersions,
    setSelectedVersions,
    loadingVersions,
    handleInstall,
    handleUninstall,
    handleUpdate,
    handleRetryStatus,
  } = useDependencySection({ addToast, isActive });

  // Only allow one operation at a time (install, uninstall, or update)
  const isAnyOperationInProgress = installingSdk !== null || uninstallingSdk !== null || updatingSdk !== null;

  return (
    <div className={styles.dependencySection}>
      <h3 className={styles.sectionTitle}>{t('settings.dependency.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.dependency.description')}</p>

      {/* SDK Install Policy Tip */}
      <div className={styles.sdkWarningBar}>
        <span className="codicon codicon-info" />
        <span className={styles.warningText}>{t('settings.dependency.installPolicyTip')}</span>
      </div>

      {/* Node.js Environment Warning */}
      {nodeAvailable === false && (
        <div className={styles.warningBanner}>
          <span className="codicon codicon-warning" />
          <span>{t('settings.dependency.nodeNotConfigured')}</span>
        </div>
      )}

      {/* SDK List */}
      <div className={styles.sdkList}>
        {loading || statusError ? (
          <ListStatus loading={loading} onRetry={handleRetryStatus} />
        ) : (
          SDK_DEFINITIONS.map((sdk) => (
            <SdkCard
              key={sdk.id}
              sdk={sdk}
              info={sdkStatus[sdk.id]}
              versionInfo={sdkVersions[sdk.id]}
              selectedVersion={selectedVersions[sdk.id] ?? ''}
              isVersionLoading={loadingVersions[sdk.id]}
              isInstalling={installingSdk === sdk.id}
              isUninstalling={uninstallingSdk === sdk.id}
              isUpdating={updatingSdk === sdk.id}
              isAnyOperationInProgress={isAnyOperationInProgress}
              nodeAvailable={nodeAvailable}
              onVersionChange={(nextVersion) => {
                setSelectedVersions((prev) => ({ ...prev, [sdk.id]: nextVersion }));
              }}
              onInstall={() => handleInstall(sdk.id)}
              onUpdate={() => handleUpdate(sdk.id)}
              onUninstall={() => handleUninstall(sdk.id)}
            />
          ))
        )}
      </div>

      {/* Install Logs */}
      {showLogs && (
        <InstallLogs logs={installLogs} onClose={() => setShowLogs(false)} />
      )}
    </div>
  );
};

export default DependencySection;
