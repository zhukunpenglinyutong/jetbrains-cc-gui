import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SdkId, SdkStatus, InstallProgress, InstallResult, UninstallResult, NodeEnvironmentStatus } from '../../../types/dependency';
import styles from './style.module.less';

interface DependencySectionProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  } else {
    console.warn('[DependencySection] sendToJava is not available');
  }
};

const SDK_DEFINITIONS = [
  {
    id: 'claude-sdk' as SdkId,
    nameKey: 'settings.dependency.claudeSdkName',
    description: 'settings.dependency.claudeSdkDescription',
    relatedProviders: ['anthropic', 'bedrock'],
  },
  {
    id: 'codex-sdk' as SdkId,
    nameKey: 'settings.dependency.codexSdkName',
    description: 'settings.dependency.codexSdkDescription',
    relatedProviders: ['openai'],
  },
];

const DependencySection = ({ addToast }: DependencySectionProps) => {
  const { t } = useTranslation();
  const [sdkStatus, setSdkStatus] = useState<Record<SdkId, SdkStatus>>({} as Record<SdkId, SdkStatus>);
  const [loading, setLoading] = useState(true);
  const [installingSdk, setInstallingSdk] = useState<SdkId | null>(null);
  const [uninstallingSdk, setUninstallingSdk] = useState<SdkId | null>(null);
  const [installLogs, setInstallLogs] = useState<string>('');
  const [showLogs, setShowLogs] = useState(false);
  const [nodeAvailable, setNodeAvailable] = useState<boolean | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Use refs to store the latest callback and t function to avoid useEffect re-runs
  const addToastRef = useRef(addToast);
  const tRef = useRef(t);

  // Update refs when props change
  useEffect(() => {
    addToastRef.current = addToast;
    tRef.current = t;
  }, [addToast, t]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logContainerRef.current && showLogs) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [installLogs, showLogs]);

  // Setup window callbacks - only run once on mount
  useEffect(() => {
    // Use a safer callback management approach:
    // 1. Save references to existing callbacks (captured when effect runs)
    // 2. Create wrapper functions instead of directly overwriting
    // 3. Restore original callbacks on cleanup

    // Capture current callback references (may have been set by App.tsx)
    const savedUpdateDependencyStatus = window.updateDependencyStatus;
    const savedDependencyInstallProgress = window.dependencyInstallProgress;
    const savedDependencyInstallResult = window.dependencyInstallResult;
    const savedDependencyUninstallResult = window.dependencyUninstallResult;
    const savedNodeEnvironmentStatus = window.nodeEnvironmentStatus;

    // Create wrapped callback functions
    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const status = JSON.parse(jsonStr);
        setSdkStatus(status);
        setLoading(false);
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency status:', error);
        setLoading(false);
      }
      // Chain call: also trigger previously saved callbacks (e.g., from App.tsx)
      if (typeof savedUpdateDependencyStatus === 'function') {
        try {
          savedUpdateDependencyStatus(jsonStr);
        } catch (e) {
          console.error('[DependencySection] Error in chained updateDependencyStatus:', e);
        }
      }
    };

    window.dependencyInstallProgress = (jsonStr: string) => {
      try {
        const progress: InstallProgress = JSON.parse(jsonStr);
        setInstallLogs((prev) => prev + progress.log + '\n');
      } catch (error) {
        console.error('[DependencySection] Failed to parse install progress:', error);
      }
      // Chain call
      if (typeof savedDependencyInstallProgress === 'function') {
        try {
          savedDependencyInstallProgress(jsonStr);
        } catch (e) {
          console.error('[DependencySection] Error in chained dependencyInstallProgress:', e);
        }
      }
    };

    window.dependencyInstallResult = (jsonStr: string) => {
      try {
        const result: InstallResult = JSON.parse(jsonStr);
        setInstallingSdk(null);

        if (result.success) {
          const sdkDef = SDK_DEFINITIONS.find(d => d.id === result.sdkId);
          const sdkName = sdkDef ? tRef.current(sdkDef.nameKey) : result.sdkId;
          addToastRef.current?.(tRef.current('settings.dependency.installSuccess', { name: sdkName }), 'success');
        } else if (result.error === 'node_not_configured') {
          addToastRef.current?.(tRef.current('settings.dependency.nodeNotConfigured'), 'warning');
        } else {
          addToastRef.current?.(tRef.current('settings.dependency.installFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse install result:', error);
        setInstallingSdk(null);
      }
      // Chain call
      if (typeof savedDependencyInstallResult === 'function') {
        try {
          savedDependencyInstallResult(jsonStr);
        } catch (e) {
          console.error('[DependencySection] Error in chained dependencyInstallResult:', e);
        }
      }
    };

    window.dependencyUninstallResult = (jsonStr: string) => {
      try {
        const result: UninstallResult = JSON.parse(jsonStr);
        setUninstallingSdk(null);

        if (result.success) {
          const sdkDef = SDK_DEFINITIONS.find(d => d.id === result.sdkId);
          const sdkName = sdkDef ? tRef.current(sdkDef.nameKey) : result.sdkId;
          addToastRef.current?.(tRef.current('settings.dependency.uninstallSuccess', { name: sdkName }), 'success');
        } else {
          addToastRef.current?.(tRef.current('settings.dependency.uninstallFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse uninstall result:', error);
        setUninstallingSdk(null);
      }
      // Chain call
      if (typeof savedDependencyUninstallResult === 'function') {
        try {
          savedDependencyUninstallResult(jsonStr);
        } catch (e) {
          console.error('[DependencySection] Error in chained dependencyUninstallResult:', e);
        }
      }
    };

    window.nodeEnvironmentStatus = (jsonStr: string) => {
      try {
        const status: NodeEnvironmentStatus = JSON.parse(jsonStr);
        setNodeAvailable(status.available);
      } catch (error) {
        console.error('[DependencySection] Failed to parse node environment status:', error);
      }
      // Chain call
      if (typeof savedNodeEnvironmentStatus === 'function') {
        try {
          savedNodeEnvironmentStatus(jsonStr);
        } catch (e) {
          console.error('[DependencySection] Error in chained nodeEnvironmentStatus:', e);
        }
      }
    };

    // Load initial status - only once on mount
    sendToJava('get_dependency_status:');
    sendToJava('check_node_environment:');

    return () => {
      // Restore previously saved callbacks on cleanup to avoid losing other components' callbacks
      window.updateDependencyStatus = savedUpdateDependencyStatus;
      window.dependencyInstallProgress = savedDependencyInstallProgress;
      window.dependencyInstallResult = savedDependencyInstallResult;
      window.dependencyUninstallResult = savedDependencyUninstallResult;
      window.nodeEnvironmentStatus = savedNodeEnvironmentStatus;
    };
  }, []); // Empty dependency array - only run once on mount

  const handleInstall = (sdkId: SdkId) => {
    if (nodeAvailable === false) {
      addToast?.(t('settings.dependency.nodeNotConfigured'), 'warning');
      return;
    }

    setInstallingSdk(sdkId);
    setInstallLogs('');
    setShowLogs(true);
    sendToJava(`install_dependency:${JSON.stringify({ id: sdkId })}`);
  };

  const handleUninstall = (sdkId: SdkId) => {
    setUninstallingSdk(sdkId);
    sendToJava(`uninstall_dependency:${JSON.stringify({ id: sdkId })}`);
  };

  const getSdkInfo = (sdkId: SdkId): SdkStatus | undefined => {
    return sdkStatus[sdkId];
  };

  const isInstalled = (sdkId: SdkId): boolean => {
    const info = getSdkInfo(sdkId);
    return info?.status === 'installed';
  };

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
        {loading ? (
          <div className={styles.loadingState}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.dependency.loading')}</span>
          </div>
        ) : (
          SDK_DEFINITIONS.map((sdk) => {
            const info = getSdkInfo(sdk.id);
            const installed = isInstalled(sdk.id);
            const isInstalling = installingSdk === sdk.id;
            const isUninstalling = uninstallingSdk === sdk.id;
            const hasUpdate = info?.hasUpdate;
            // Only allow one operation at a time (install or uninstall)
            const isAnyOperationInProgress = installingSdk !== null || uninstallingSdk !== null;

            return (
              <div key={sdk.id} className={styles.sdkCard}>
                <div className={styles.sdkHeader}>
                  <div className={styles.sdkInfo}>
                    <div className={styles.sdkName}>
                      <span className={`codicon ${installed ? 'codicon-check' : 'codicon-package'}`} />
                      <span>{t(sdk.nameKey)}</span>
                      {installed && info?.installedVersion && (
                        <span className={styles.versionBadge}>v{info.installedVersion}</span>
                      )}
                      {hasUpdate && (
                        <span className={styles.updateBadge}>
                          {t('settings.dependency.updateAvailable')}
                        </span>
                      )}
                    </div>
                    <div className={styles.sdkDescription}>{t(sdk.description)}</div>
                  </div>

                  <div className={styles.sdkActions}>
                    {!installed ? (
                      <button
                        className={`${styles.installBtn} ${isInstalling ? styles.installing : ''}`}
                        onClick={() => handleInstall(sdk.id)}
                        disabled={isAnyOperationInProgress || nodeAvailable === false}
                      >
                        {isInstalling ? (
                          <>
                            <span className="codicon codicon-loading codicon-modifier-spin" />
                            <span>{t('settings.dependency.installing')}</span>
                          </>
                        ) : (
                          <>
                            <span className="codicon codicon-cloud-download" />
                            <span>{t('settings.dependency.install')}</span>
                          </>
                        )}
                      </button>
                    ) : (
                      <>
                        {hasUpdate && (
                          <button
                            className={styles.updateBtn}
                            onClick={() => handleInstall(sdk.id)}
                            disabled={isAnyOperationInProgress}
                          >
                            <span className="codicon codicon-sync" />
                            <span>{t('settings.dependency.update')}</span>
                          </button>
                        )}
                        <button
                          className={styles.uninstallBtn}
                          onClick={() => handleUninstall(sdk.id)}
                          disabled={isAnyOperationInProgress}
                        >
                          {isUninstalling ? (
                            <>
                              <span className="codicon codicon-loading codicon-modifier-spin" />
                              <span>{t('settings.dependency.uninstalling')}</span>
                            </>
                          ) : (
                            <>
                              <span className="codicon codicon-trash" />
                              <span>{t('settings.dependency.uninstall')}</span>
                            </>
                          )}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Install path info */}
                {installed && info?.installPath && (
                  <div className={styles.installPath}>
                    <span className="codicon codicon-folder" />
                    <span>{info.installPath}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Install Logs */}
      {showLogs && (
        <div className={styles.logsSection}>
          <div className={styles.logsHeader}>
            <span>{t('settings.dependency.installLogs')}</span>
            <button className={styles.closeLogsBtn} onClick={() => setShowLogs(false)}>
              <span className="codicon codicon-close" />
            </button>
          </div>
          <div className={styles.logsContainer} ref={logContainerRef}>
            <pre>{installLogs || t('settings.dependency.waitingForLogs')}</pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default DependencySection;
