import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

interface InstallLogsProps {
  logs: string;
  onClose: () => void;
}

const InstallLogs = ({ logs, onClose }: InstallLogsProps) => {
  const { t } = useTranslation();
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className={styles.logsSection}>
      <div className={styles.logsHeader}>
        <span>{t('settings.dependency.installLogs')}</span>
        <button className={styles.closeLogsBtn} onClick={onClose}>
          <span className="codicon codicon-close" />
        </button>
      </div>
      <div className={styles.logsContainer} ref={logContainerRef}>
        <pre>{logs || t('settings.dependency.waitingForLogs')}</pre>
      </div>
    </div>
  );
};

export default InstallLogs;
