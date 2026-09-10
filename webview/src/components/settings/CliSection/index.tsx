import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '../../../utils/copyUtils';
import { openBrowserExternal } from '../../../utils/bridge';
import CliToolList from './CliToolList';
import InstallDialog from './InstallDialog';
import { useHiddenCliProviders } from '../../../hooks/useCliProviderVisibility';
import { setCliProviderHidden } from '../../../utils/cliProviderVisibility';
import {
  CLI_TOOL_DEFINITIONS,
  type CliStatusMap,
  type CliToolDefinition,
  type CliToolId,
  type CliToolStatus,
} from '../../../types/cliTool';
import styles from './style.module.less';

interface CliSectionProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

/** Java may not answer get_cli_status (handler absent) — show an error instead of spinning forever. */
const CLI_STATUS_TIMEOUT_MS = 15_000;

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

const isCliToolStatus = (value: unknown): value is CliToolStatus => {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.installed === 'boolean';
};

const parseCliStatusPayload = (json: string): CliStatusMap | null => {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.error === 'string') {
      return null;
    }
    const map: CliStatusMap = {};
    for (const def of CLI_TOOL_DEFINITIONS) {
      const entry = parsed[def.id];
      if (isCliToolStatus(entry)) {
        map[def.id] = entry;
      }
    }
    return map;
  } catch {
    return null;
  }
};

const CliSection = ({ addToast }: CliSectionProps) => {
  const { t } = useTranslation();
  const [statusMap, setStatusMap] = useState<CliStatusMap>({});
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [installTool, setInstallTool] = useState<CliToolDefinition | null>(null);
  const addToastRef = useRef(addToast);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenProviders = useHiddenCliProviders();

  useEffect(() => {
    addToastRef.current = addToast;
  }, [addToast]);

  const clearStatusTimeout = useCallback(() => {
    if (statusTimeoutRef.current) {
      clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = null;
    }
  }, []);

  const requestStatus = useCallback(() => {
    clearStatusTimeout();
    setLoading(true);
    setStatusError(false);
    sendToJava('get_cli_status:');
    statusTimeoutRef.current = setTimeout(() => {
      statusTimeoutRef.current = null;
      setStatusError(true);
      setLoading(false);
    }, CLI_STATUS_TIMEOUT_MS);
  }, [clearStatusTimeout]);

  useEffect(() => {
    const previous = window.updateCliStatus;
    window.updateCliStatus = (json: string) => {
      clearStatusTimeout();
      const parsed = parseCliStatusPayload(json);
      // A payload that parses but matches no known tool means the shape is
      // unknown — treat it as an error, not "everything not installed".
      if (!parsed || Object.keys(parsed).length === 0) {
        setStatusError(true);
        setLoading(false);
        return;
      }
      setStatusMap(parsed);
      setStatusError(false);
      setLoading(false);
    };

    requestStatus();

    return () => {
      window.updateCliStatus = previous;
      clearStatusTimeout();
    };
  }, [requestStatus, clearStatusTimeout]);

  const handleCopy = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    addToastRef.current?.(
      ok ? t('settings.cli.copied') : t('settings.cli.copyFailed'),
      ok ? 'success' : 'error',
    );
  }, [t]);

  const openInstallGuide = useCallback((id: CliToolId) => {
    const def = CLI_TOOL_DEFINITIONS.find((item) => item.id === id) ?? null;
    setInstallTool(def);
  }, []);

  const openDocs = useCallback((url: string) => {
    // CLI docs pages are SPAs that often render blank in the embedded JCEF
    // preview — open them in the system default browser instead.
    openBrowserExternal(url);
  }, []);
  const toggleSwitcherVisibility = useCallback((id: CliToolId, hidden: boolean) => {
    setCliProviderHidden(id, hidden);
  }, []);

  const { installedCount, totalCount, hasStatus } = useMemo(() => {
    const total = CLI_TOOL_DEFINITIONS.length;
    const known = CLI_TOOL_DEFINITIONS.filter((tool) => statusMap[tool.id] !== undefined);
    const installed = known.filter((tool) => statusMap[tool.id]?.installed).length;
    return {
      installedCount: installed,
      totalCount: total,
      hasStatus: known.length > 0,
    };
  }, [statusMap]);

  const summaryClass =
    hasStatus && installedCount === totalCount
      ? styles.ready
      : hasStatus && installedCount > 0
        ? styles.partial
        : undefined;

  return (
    <div className={styles.cliSection}>
      <div className={styles.header}>
        <div className={styles.headerTitleRow}>
          <div className={styles.headerTitleGroup}>
            <h4 className={styles.headerTitle}>{t('settings.cli.listTitle')}</h4>
            {hasStatus && !loading && (
              <span className={`${styles.summaryBadge} ${summaryClass ?? ''}`}>
                {t('settings.cli.summary', {
                  installed: installedCount,
                  total: totalCount,
                })}
              </span>
            )}
          </div>
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={requestStatus}
            disabled={loading}
          >
            <span className={`codicon codicon-refresh ${loading ? 'codicon-modifier-spin' : ''}`} />
            {t('settings.cli.refresh')}
          </button>
        </div>
        <p className={styles.headerHint}>{t('settings.cli.hint')}</p>
      </div>

      <CliToolList
        loading={loading}
        statusError={statusError}
        statusMap={statusMap}
        onRefresh={requestStatus}
        onOpenInstall={openInstallGuide}
        onOpenDocs={openDocs}
        hiddenProviders={hiddenProviders}
        onToggleSwitcherVisibility={toggleSwitcherVisibility}
      />

      {!loading && !statusError && Object.keys(statusMap).length > 0 && (
        <p className={styles.moreComing}>{t('settings.cli.moreComingSoon')}</p>
      )}

      <InstallDialog
        tool={installTool}
        onClose={() => setInstallTool(null)}
        onCopy={handleCopy}
        onOpenDocs={openDocs}
      />
    </div>
  );
};

export default CliSection;
