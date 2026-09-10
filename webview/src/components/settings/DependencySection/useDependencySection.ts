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
  DependencyVersionInfo,
  DependencyVersionResult,
} from '../../../types/dependency';
import {
  buildVersionOptions,
  getRequestedVersion,
} from './versioning';
import {
  isDependencyStatusResponse,
  requestFreshDependencyStatus,
  requestDependencyStatusUntilSettled,
  retryDependencyStatusRequest,
  settleDependencyStatusRequest,
} from '../../../utils/bridgeStartup';

export interface DependencySectionProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  isActive: boolean;
}

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
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

export const SDK_DEFINITIONS = [
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

export const useDependencySection = ({ addToast, isActive }: DependencySectionProps) => {
  const { t } = useTranslation();
  const [sdkStatus, setSdkStatus] = useState<Record<SdkId, SdkStatus>>({} as Record<SdkId, SdkStatus>);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [installingSdk, setInstallingSdk] = useState<SdkId | null>(null);
  const [uninstallingSdk, setUninstallingSdk] = useState<SdkId | null>(null);
  const [updatingSdk, setUpdatingSdk] = useState<SdkId | null>(null);
  const updatingSdkRef = useRef<SdkId | null>(null);
  const [installLogs, setInstallLogs] = useState<string>('');
  const [showLogs, setShowLogs] = useState(false);
  const [nodeAvailable, setNodeAvailable] = useState<boolean | null>(null);
  const [sdkVersions, setSdkVersions] = useState<Record<SdkId, DependencyVersionInfo>>({} as Record<SdkId, DependencyVersionInfo>);
  const [selectedVersions, setSelectedVersions] = useState<Record<SdkId, string>>({} as Record<SdkId, string>);
  const [loadingVersions, setLoadingVersions] = useState<Record<SdkId, boolean>>({
    'claude-sdk': false,
    'codex-sdk': false,
  });
  const isNodePathReadyRef = useRef(false);
  const sdkStatusRef = useRef<Record<SdkId, SdkStatus>>({} as Record<SdkId, SdkStatus>);

  // Use refs to store the latest callback and t function to avoid useEffect re-runs
  const addToastRef = useRef(addToast);
  const tRef = useRef(t);

  // Update refs when props change
  useEffect(() => {
    addToastRef.current = addToast;
    tRef.current = t;
  }, [addToast, t]);

  useEffect(() => {
    sdkStatusRef.current = sdkStatus;
  }, [sdkStatus]);

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
    const savedDependencyVersionsLoaded = window.dependencyVersionsLoaded;
    const savedNodeEnvironmentStatus = window.nodeEnvironmentStatus;
    const savedCheckNodeEnvironment = window.checkNodeEnvironment;
    const savedRunNodeEnvironmentStressTest = window.runNodeEnvironmentStressTest;

    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const status = JSON.parse(jsonStr);
        if (!isDependencyStatusResponse(status)) {
          setStatusError(true);
          setLoading(false);
          settleDependencyStatusRequest('error');
        } else {
          setSdkStatus(status);
          sdkStatusRef.current = status;
          setStatusError(false);
          setLoading(false);
          settleDependencyStatusRequest('ready');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency status:', error);
        setStatusError(true);
        setLoading(false);
        settleDependencyStatusRequest('error');
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
          setStatusError(false);
          setLoading(true);
          requestFreshDependencyStatus();
          sendToJava(`check_dependency_updates:${JSON.stringify({ id: result.sdkId })}`);
          sendToJava(`get_dependency_versions:${JSON.stringify({ id: result.sdkId })}`);
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
          sendToJava(`get_dependency_versions:${JSON.stringify({ id: result.sdkId })}`);
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

    window.dependencyVersionsLoaded = (jsonStr: string) => {
      try {
        const versionsPayload: DependencyVersionResult = JSON.parse(jsonStr);
        setSdkVersions((prev) => ({ ...prev, ...versionsPayload }));
        setLoadingVersions((prev) => {
          const next = { ...prev };
          Object.keys(versionsPayload).forEach((sdkId) => {
            next[sdkId as SdkId] = false;
          });
          return next;
        });
        setSelectedVersions((prev) => {
          const next = { ...prev };

          Object.entries(versionsPayload).forEach(([sdkId, versionInfo]) => {
            const typedSdkId = sdkId as SdkId;
            const installedVersion = sdkStatusRef.current[typedSdkId]?.installedVersion;
            const options = buildVersionOptions({
              availableVersions: versionInfo.versions,
              fallbackVersions: versionInfo.fallbackVersions,
              installedVersion,
            });
            const preferred = installedVersion ?? versionInfo.latestVersion ?? options[0];
            const current = getRequestedVersion(next[typedSdkId]);
            if (!current || !options.includes(current)) {
              next[typedSdkId] = preferred ?? '';
            }
          });

          return next;
        });
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency versions result:', error);
      }
      if (typeof savedDependencyVersionsLoaded === 'function') {
        try { savedDependencyVersionsLoaded(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyVersionsLoaded:', e);
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
    if (window.__pendingDependencyVersions) {
      window.dependencyVersionsLoaded(window.__pendingDependencyVersions);
      window.__pendingDependencyVersions = undefined;
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
      window.dependencyVersionsLoaded = savedDependencyVersionsLoaded;
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
    setLoadingVersions({
      'claude-sdk': true,
      'codex-sdk': true,
    });
    setStatusError(false);
    setLoading(true);
    if (window.__dependencyStatusState === 'pending') {
      requestDependencyStatusUntilSettled();
    } else {
      retryDependencyStatusRequest();
    }
    sendToJava('check_dependency_updates:');
    sendToJava('get_dependency_versions:');
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
    sendToJava(`install_dependency:${JSON.stringify({ id: sdkId, version: getRequestedVersion(selectedVersions[sdkId]) })}`);
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
    sendToJava(`update_dependency:${JSON.stringify({ id: sdkId, version: getRequestedVersion(selectedVersions[sdkId]) })}`);
  };

  const handleRetryStatus = () => {
    setStatusError(false);
    setLoading(true);
    retryDependencyStatusRequest();
  };

  return {
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
  };
};
