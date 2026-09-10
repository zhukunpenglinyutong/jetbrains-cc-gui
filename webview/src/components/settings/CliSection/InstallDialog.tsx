import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { type CliToolDefinition } from '../../../types/cliTool';
import styles from './style.module.less';

interface InstallDialogProps {
  tool: CliToolDefinition | null;
  onClose: () => void;
  onCopy: (text: string) => void;
  onOpenDocs: (url: string) => void;
}

const InstallDialog = ({ tool, onClose, onCopy, onOpenDocs }: InstallDialogProps) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!tool) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, onClose]);

  if (!tool) return null;

  const name = t(tool.nameKey);

  return (
    <div className={styles.dialogOverlay} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-install-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.dialogHeader}>
          <span className="codicon codicon-terminal" aria-hidden="true" />
          <h4 id="cli-install-dialog-title" className={styles.dialogTitle}>
            {t('settings.cli.installDialog.title', { name })}
          </h4>
          <button
            type="button"
            className={styles.dialogClose}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className={styles.dialogBody}>
          <p className={styles.dialogLead}>
            {t('settings.cli.installDialog.lead', { name, binary: tool.binaryName })}
          </p>

          <ol className={styles.stepList}>
            <li>{t('settings.cli.installDialog.stepOpenTerminal')}</li>
            <li>{t('settings.cli.installDialog.stepRunCommand')}</li>
            <li>{t('settings.cli.installDialog.stepVerify', { binary: tool.binaryName })}</li>
            <li>{t('settings.cli.installDialog.stepReturn')}</li>
          </ol>

          <p className={styles.commandLabel}>{t('settings.cli.installDialog.primaryCommand')}</p>
          <div className={styles.commandBlock}>
            {tool.installCommand}
            <button
              type="button"
              className={styles.copyBtn}
              onClick={() => onCopy(tool.installCommand)}
              title={t('settings.cli.copy')}
              aria-label={t('settings.cli.copy')}
            >
              <span className="codicon codicon-copy" />
            </button>
          </div>

          {tool.installCommandWindows && (
            <>
              <p className={styles.commandLabel}>{t('settings.cli.installDialog.windowsCommand')}</p>
              <div className={styles.commandBlock}>
                {tool.installCommandWindows}
                <button
                  type="button"
                  className={styles.copyBtn}
                  onClick={() => onCopy(tool.installCommandWindows!)}
                  title={t('settings.cli.copy')}
                  aria-label={t('settings.cli.copy')}
                >
                  <span className="codicon codicon-copy" />
                </button>
              </div>
            </>
          )}

          {tool.altInstallCommand && (
            <>
              <p className={styles.commandLabel}>{t('settings.cli.installDialog.altCommand')}</p>
              <div className={styles.commandBlock}>
                {tool.altInstallCommand}
                <button
                  type="button"
                  className={styles.copyBtn}
                  onClick={() => onCopy(tool.altInstallCommand!)}
                  title={t('settings.cli.copy')}
                  aria-label={t('settings.cli.copy')}
                >
                  <span className="codicon codicon-copy" />
                </button>
              </div>
            </>
          )}

          <a
            className={styles.docsLink}
            href={tool.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => {
              // JCEF won't route target=_blank to the system browser — go through the bridge.
              e.preventDefault();
              onOpenDocs(tool.docsUrl);
            }}
          >
            <span className="codicon codicon-link-external" aria-hidden="true" />
            {t('settings.cli.installDialog.openDocs')}
          </a>
        </div>

        <div className={styles.dialogFooter}>
          <button type="button" className={styles.dialogPrimaryBtn} onClick={onClose}>
            {t('common.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default InstallDialog;
