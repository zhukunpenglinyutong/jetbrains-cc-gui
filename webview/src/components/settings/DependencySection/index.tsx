import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SdkId,
  SdkStatus,
  InstallProgress,
  InstallResult,
  UninstallResult,
  NodeEnvironmentStatus,
  UpdateCheckResult,
} from '../../../types/dependency';
import styles from './style.module.less';

interface DependencySectionProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  isActive: boolean;
}

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  } else {
    console.warn('[DependencySection] sendToJava is not available');
  }
};

const mergeDependencyUpdates = (
  previousStatus: Record<SdkId, SdkStatus>,
  updatePayload: UpdateCheckResult,
): Record<SdkId, SdkStatus> => {
  const nextStatus = { ...previousStatus };

  Object.entries(updatePayload).forEach(([sdkId, updateInfo]) => {
    const typedSdkId = sdkId as SdkId;
    const currentStatus = nextStatus[typedSdkId];
    if (!currentStatus) {
      return;
    }

    nextStatus[typedSdkId] = {
      ...currentStatus,
      hasUpdate: updateInfo.hasUpdate,
      latestVersion: updateInfo.latestVersion,
      lastChecked: new Date().toISOString(),
      errorMessage: updateInfo.error ?? currentStatus.errorMessage,
    };
  });

  return nextStatus;
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

const DependencySection = ({ addToast, isActive }: DependencySectionProps) => {
  const { t } = useTranslation();
  const [sdkStatus, setSdkStatus] = useState<Record<SdkId, SdkStatus>>({} as Record<SdkId, SdkStatus>);
  const [loading, setLoading] = useState(true);
  const [installingSdk, setInstallingSdk] = useState<SdkId | null>(null);
  const [uninstallingSdk, setUninstallingSdk] = useState<SdkId | null>(null);
  const [updatingSdk, setUpdatingSdk] = useState<SdkId | null>(null);
  const updatingSdkRef = useRef<SdkId | null>(null);
  const [installLogs, setInstallLogs] = useState<string>('');
  const [showLogs, setShowLogs] = useState(false);
  const [nodeAvailable, setNodeAvailable] = useState<boolean | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isNodePathReadyRef = useRef(false);

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

  // Use a ref to track isActive so the mount-only effect can access the latest value
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Setup window callbacks - run once on mount only
  useEffect(() => {
    // Capture current callback references (may have been set by App.tsx)
    const savedUpdateDependencyStatus = window.updateDependencyStatus;
    const savedDependencyInstallProgress = window.dependencyInstallProgress;
    const savedDependencyInstallResult = window.dependencyInstallResult;
    const savedDependencyUninstallResult = window.dependencyUninstallResult;
    const savedDependencyUpdateAvailable = window.dependencyUpdateAvailable;
    const savedNodeEnvironmentStatus = window.nodeEnvironmentStatus;
    const savedCheckNodeEnvironment = window.checkNodeEnvironment;
    const savedRunNodeEnvironmentStressTest = window.runNodeEnvironmentStressTest;

    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const status = JSON.parse(jsonStr);
        setSdkStatus(status);
        setLoading(false);
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency status:', error);
        setLoading(false);
      }
      if (typeof savedUpdateDependencyStatus === 'function') {
        try { savedUpdateDependencyStatus(jsonStr); } catch (e) {
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
      if (typeof savedDependencyInstallProgress === 'function') {
        try { savedDependencyInstallProgress(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyInstallProgress:', e);
        }
      }
    };

    window.dependencyInstallResult = (jsonStr: string) => {
      try {
        const result: InstallResult = JSON.parse(jsonStr);
        const wasUpdating = updatingSdkRef.current === result.sdkId;
        setInstallingSdk(null);
        setUpdatingSdk(null);
        updatingSdkRef.current = null;

        if (result.success) {
          const sdkDef = SDK_DEFINITIONS.find(d => d.id === result.sdkId);
          const sdkName = sdkDef ? tRef.current(sdkDef.nameKey) : result.sdkId;
          const msgKey = wasUpdating ? 'settings.dependency.updateSuccess' : 'settings.dependency.installSuccess';
          addToastRef.current?.(tRef.current(msgKey, { name: sdkName }), 'success');
          sendToJava('get_dependency_status:');
          sendToJava(`check_dependency_updates:${JSON.stringify({ id: result.sdkId })}`);
        } else if (result.error === 'node_not_configured') {
          addToastRef.current?.(tRef.current('settings.dependency.nodeNotConfigured'), 'warning');
        } else {
          addToastRef.current?.(tRef.current('settings.dependency.installFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse install result:', error);
        setInstallingSdk(null);
        setUpdatingSdk(null);
        updatingSdkRef.current = null;
      }
      if (typeof savedDependencyInstallResult === 'function') {
        try { savedDependencyInstallResult(jsonStr); } catch (e) {
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
          setSdkStatus((prev) => ({
            ...prev,
            [result.sdkId]: {
              ...prev[result.sdkId],
              hasUpdate: false,
              latestVersion: undefined,
              lastChecked: new Date().toISOString(),
              errorMessage: undefined,
            },
          }));
        } else {
          addToastRef.current?.(tRef.current('settings.dependency.uninstallFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse uninstall result:', error);
        setUninstallingSdk(null);
      }
      if (typeof savedDependencyUninstallResult === 'function') {
        try { savedDependencyUninstallResult(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyUninstallResult:', e);
        }
      }
    };

    window.dependencyUpdateAvailable = (jsonStr: string) => {
      try {
        const updatePayload: UpdateCheckResult = JSON.parse(jsonStr);
        setSdkStatus((prev) => mergeDependencyUpdates(prev, updatePayload));
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency update result:', error);
      }
      if (typeof savedDependencyUpdateAvailable === 'function') {
        try { savedDependencyUpdateAvailable(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyUpdateAvailable:', e);
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
      if (typeof savedNodeEnvironmentStatus === 'function') {
        try { savedNodeEnvironmentStatus(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained nodeEnvironmentStatus:', e);
        }
      }
    };
    window.checkNodeEnvironment = () => {
      sendToJava('check_node_environment:');
      savedCheckNodeEnvironment?.();
    };
    if (import.meta.env.DEV) {
      window.runNodeEnvironmentStressTest = (count: number = 10) => {
        for (let i = 0; i < count; i += 1) {
          sendToJava('check_node_environment:');
        }
        savedRunNodeEnvironmentStressTest?.(count);
      };
    }

    if (window.__pendingDependencyUpdates) {
      window.dependencyUpdateAvailable(window.__pendingDependencyUpdates);
      window.__pendingDependencyUpdates = undefined;
    }

    const handleNodePathReady = () => {
      isNodePathReadyRef.current = true;
      if (isActiveRef.current) {
        sendToJava('check_node_environment:');
      }
    };
    window.addEventListener('nodePathReady', handleNodePathReady);

    return () => {
      window.updateDependencyStatus = savedUpdateDependencyStatus;
      window.dependencyInstallProgress = savedDependencyInstallProgress;
      window.dependencyInstallResult = savedDependencyInstallResult;
      window.dependencyUninstallResult = savedDependencyUninstallResult;
      window.dependencyUpdateAvailable = savedDependencyUpdateAvailable;
      window.nodeEnvironmentStatus = savedNodeEnvironmentStatus;
      window.checkNodeEnvironment = savedCheckNodeEnvironment;
      window.runNodeEnvironmentStressTest = savedRunNodeEnvironmentStressTest;
      window.removeEventListener('nodePathReady', handleNodePathReady);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch data when tab becomes active
  useEffect(() => {
    if (!isActive) {
      return;
    }
    sendToJava('get_dependency_status:');
    sendToJava('check_dependency_updates:');
    if (isNodePathReadyRef.current) {
      sendToJava('check_node_environment:');
    }
  }, [isActive]);

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

  const handleUpdate = (sdkId: SdkId) => {
    if (nodeAvailable === false) {
      addToast?.(t('settings.dependency.nodeNotConfigured'), 'warning');
      return;
    }

    setUpdatingSdk(sdkId);
    updatingSdkRef.current = sdkId;
    setInstallLogs('');
    setShowLogs(true);
    sendToJava(`update_dependency:${JSON.stringify({ id: sdkId })}`);
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
            const isUpdating = updatingSdk === sdk.id;
            const hasUpdate = info?.hasUpdate;
            // Only allow one operation at a time (install, uninstall, or update)
            const isAnyOperationInProgress = installingSdk !== null || uninstallingSdk !== null || updatingSdk !== null;
            const updateDisabled = isAnyOperationInProgress || nodeAvailable === false || !hasUpdate;

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
                      {installed && hasUpdate && info?.latestVersion && (
                        <span className={styles.versionBadge}>→ v{info.latestVersion}</span>
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
                        <button
                          className={styles.updateBtn}
                          onClick={() => handleUpdate(sdk.id)}
                          disabled={updateDisabled}
                        >
                          {isUpdating ? (
                            <>
                              <span className="codicon codicon-loading codicon-modifier-spin" />
                              <span>{t('settings.dependency.updating')}</span>
                            </>
                          ) : (
                            <>
                              <span className="codicon codicon-sync" />
                              <span>{t('settings.dependency.update')}</span>
                            </>
                          )}
                        </button>
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
