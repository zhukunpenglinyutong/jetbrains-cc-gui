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

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logContainerRef.current && showLogs) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [installLogs, showLogs]);

  useEffect(() => {
    // Set up global callbacks
    // 🔧 使用装饰器模式，保存 App.tsx 的回调并扩展
    const appCallback = (window as any)._appUpdateDependencyStatus;
    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const status = JSON.parse(jsonStr);
        setSdkStatus(status);
        setLoading(false);
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency status:', error);
        setLoading(false);
      }
      // 同时调用 App.tsx 的回调，确保全局 SDK 状态也更新
      if (appCallback) {
        appCallback(jsonStr);
      }
    };

    window.dependencyInstallProgress = (jsonStr: string) => {
      try {
        const progress: InstallProgress = JSON.parse(jsonStr);
        setInstallLogs((prev) => prev + progress.log + '\n');
      } catch (error) {
        console.error('[DependencySection] Failed to parse install progress:', error);
      }
    };

    window.dependencyInstallResult = (jsonStr: string) => {
      try {
        const result: InstallResult = JSON.parse(jsonStr);
        setInstallingSdk(null);

        if (result.success) {
          const sdkDef = SDK_DEFINITIONS.find(d => d.id === result.sdkId);
          const sdkName = sdkDef ? t(sdkDef.nameKey) : result.sdkId;
          addToast?.(t('settings.dependency.installSuccess', { name: sdkName }), 'success');
        } else if (result.error === 'node_not_configured') {
          addToast?.(t('settings.dependency.nodeNotConfigured'), 'warning');
        } else {
          addToast?.(t('settings.dependency.installFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse install result:', error);
        setInstallingSdk(null);
      }
    };

    window.dependencyUninstallResult = (jsonStr: string) => {
      try {
        const result: UninstallResult = JSON.parse(jsonStr);
        setUninstallingSdk(null);

        if (result.success) {
          const sdkDef = SDK_DEFINITIONS.find(d => d.id === result.sdkId);
          const sdkName = sdkDef ? t(sdkDef.nameKey) : result.sdkId;
          addToast?.(t('settings.dependency.uninstallSuccess', { name: sdkName }), 'success');
        } else {
          addToast?.(t('settings.dependency.uninstallFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse uninstall result:', error);
        setUninstallingSdk(null);
      }
    };

    window.nodeEnvironmentStatus = (jsonStr: string) => {
      try {
        const status: NodeEnvironmentStatus = JSON.parse(jsonStr);
        setNodeAvailable(status.available);
      } catch (error) {
        console.error('[DependencySection] Failed to parse node environment status:', error);
      }
    };

    // Load initial status
    sendToJava('get_dependency_status:');
    sendToJava('check_node_environment:');

    return () => {
      // 🔧 恢复 App.tsx 的回调，而不是设置为 undefined
      if (appCallback) {
        window.updateDependencyStatus = appCallback;
      } else {
        window.updateDependencyStatus = undefined;
      }
      window.dependencyInstallProgress = undefined;
      window.dependencyInstallResult = undefined;
      window.dependencyUninstallResult = undefined;
      window.nodeEnvironmentStatus = undefined;
    };
  }, [addToast, t]);

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
                        disabled={isInstalling || nodeAvailable === false}
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
                            disabled={isInstalling}
                          >
                            <span className="codicon codicon-sync" />
                            <span>{t('settings.dependency.update')}</span>
                          </button>
                        )}
                        <button
                          className={styles.uninstallBtn}
                          onClick={() => handleUninstall(sdk.id)}
                          disabled={isUninstalling}
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
