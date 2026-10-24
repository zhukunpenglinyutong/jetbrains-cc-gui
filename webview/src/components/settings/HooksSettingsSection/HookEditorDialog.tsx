import { useEffect, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HookEditorTarget } from '../../../types/hooks';
import type { UseHookManagementReturn } from '../hooks';
import { buildHookSourceDiff } from '../hooks/hookSourceDiff';
import styles from './style.module.less';
import {
  formatTimestamp,
  isHookItem,
  issueLabel,
  PROVIDER_LABELS,
  scopeLabel,
  targetLocation,
} from './utils';

type ActiveEditor = NonNullable<UseHookManagementReturn['editor']>;

interface HookEditorDialogProps {
  selected: HookEditorTarget;
  activeEditor: ActiveEditor | null;
  draft: string;
  showDiff: boolean;
  sourceLoading: boolean;
  mutationLoading: boolean;
  sourceError: string | null;
  mutationError: string | null;
  canRestore: boolean;
  lastBackupPath: string | null;
  onDraftChange: (draft: string) => void;
  onToggleDiff: () => void;
  onRestore: () => void;
  onSave: () => void;
  onResolveConflict: (preserveDraft: boolean) => void;
  onDiscardConflict: () => void;
  onRequestClose: () => void;
}

export default function HookEditorDialog({
  selected,
  activeEditor,
  draft,
  showDiff,
  sourceLoading,
  mutationLoading,
  sourceError,
  mutationError,
  canRestore,
  lastBackupPath,
  onDraftChange,
  onToggleDiff,
  onRestore,
  onSave,
  onResolveConflict,
  onDiscardConflict,
  onRequestClose,
}: HookEditorDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const hasDraftChanges = activeEditor?.content !== null && activeEditor?.content !== undefined
    && draft !== activeEditor.content;
  const diffLines = useMemo(
    () => showDiff && activeEditor?.content !== null && activeEditor?.content !== undefined
      ? buildHookSourceDiff(activeEditor.content, draft) : [],
    [activeEditor?.content, draft, showDiff],
  );
  const providerExtensions = isHookItem(selected) && Object.keys(selected.extensions).length > 0
    ? JSON.stringify(selected.extensions, null, 2) : null;
  const validationSummary = selected.validationIssues.map((issue) => issueLabel(issue, t));

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onRequestClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onRequestClose]);

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={onRequestClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <div className={styles.modalHeading}>
            <h4 id={titleId}>{isHookItem(selected) ? selected.event : t('settings.hooks.sourceEditor')}</h4>
            <div className={styles.modalMeta}>
              <span>{PROVIDER_LABELS[selected.provider]}</span>
              <span>{scopeLabel(selected.scope, t)}</span>
            </div>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onRequestClose}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>

        <div className={styles.modalLocation} title={targetLocation(selected)}>
          <span className="codicon codicon-file-code" aria-hidden="true" />
          <code>{targetLocation(selected)}</code>
        </div>

        {validationSummary.length > 0 && (
          <div className={styles.inlineNotice} role="alert">
            <span className="codicon codicon-warning" aria-hidden="true" />
            <span>{validationSummary.join('; ')}</span>
          </div>
        )}

        {sourceLoading ? (
          <div className={styles.editorLoading}>
            <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
            {t('settings.hooks.loadingSource')}
          </div>
        ) : (
          <div className={styles.editorWorkspace}>
            <textarea
              className={styles.editor}
              value={draft}
              aria-label={t('settings.hooks.sourceEditor')}
              onChange={(event) => onDraftChange(event.target.value)}
              disabled={activeEditor?.content == null}
              spellCheck={false}
            />
            {showDiff && (
              <div className={styles.diffPanel}>
                <div className={styles.diffHeading}>
                  <strong>{hasDraftChanges ? t('settings.hooks.reviewChanges') : t('settings.hooks.noChanges')}</strong>
                </div>
                {hasDraftChanges && (
                  <div className={styles.diffView}>
                    {diffLines.map((line, index) => (
                      <div
                        key={`${line.type}-${line.oldLine ?? '-'}-${line.newLine ?? '-'}-${index}`}
                        className={`${styles.diffLine} ${line.type === 'added' ? styles.diffAdded : line.type === 'removed' ? styles.diffRemoved : styles.diffContext}`}
                      >
                        <span className={styles.diffMarker}>{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}</span>
                        <span className={styles.diffNumbers}>{line.oldLine ?? ''}/{line.newLine ?? ''}</span>
                        <code>{line.text || ' '}</code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <details className={styles.technicalDetails}>
          <summary>{t('settings.hooks.technicalInfo')}</summary>
          <dl className={styles.detailsGrid}>
            <div><dt>{t('settings.hooks.format')}</dt><dd>{selected.format}</dd></div>
            <div><dt>{t('settings.hooks.revision')}</dt><dd>{activeEditor?.revision ?? selected.revision}</dd></div>
            <div><dt>{t('settings.hooks.lastModified')}</dt><dd>{formatTimestamp(activeEditor?.lastModified ?? selected.lastModified)}</dd></div>
            <div><dt>{t('settings.hooks.backupDirectory')}</dt><dd>{activeEditor?.backupDirectory ?? '-'}</dd></div>
            {lastBackupPath && (
              <div className={styles.detailsWide}><dt>{t('settings.hooks.latestBackup')}</dt><dd>{lastBackupPath}</dd></div>
            )}
            {isHookItem(selected) && selected.matcher && (
              <div className={styles.detailsWide}><dt>{t('settings.hooks.matcher')}</dt><dd>{selected.matcher}</dd></div>
            )}
            {isHookItem(selected) && (
              <div className={styles.detailsWide}><dt>{t('settings.hooks.command')}</dt><dd>{selected.command || '-'}</dd></div>
            )}
            {providerExtensions && (
              <div className={styles.detailsWide}>
                <dt>{t('settings.hooks.providerFields')}</dt>
                <dd><pre>{providerExtensions}</pre></dd>
              </div>
            )}
          </dl>
        </details>

        {sourceError && (
          <div className={styles.inlineNotice} role="alert">{t('settings.hooks.sourceLoadFailed')}: {sourceError}</div>
        )}
        {mutationError === 'HOOK_REVISION_CONFLICT' ? (
          <div className={styles.conflictNotice} role="alert">
            <div>
              <strong>{t('settings.hooks.conflictTitle')}</strong>
              <p>{t('settings.hooks.conflictDescription')}</p>
            </div>
            <div className={styles.conflictActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => onResolveConflict(false)} disabled={sourceLoading}>
                {t('settings.hooks.reloadExternal')}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => onResolveConflict(true)} disabled={sourceLoading}>
                {t('settings.hooks.keepDraft')}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={onDiscardConflict}>
                {t('settings.hooks.discardDraft')}
              </button>
            </div>
          </div>
        ) : mutationError && (
          <div className={styles.inlineNotice} role="alert">{t('settings.hooks.saveFailed')}: {mutationError}</div>
        )}

        <footer className={styles.modalFooter}>
          <span className={styles.backupHint}>
            <span className="codicon codicon-shield" aria-hidden="true" />
            {t('settings.hooks.backupOnSave')}
          </span>
          <div className={styles.footerActions}>
            {canRestore && (
              <details className={styles.moreMenu}>
                <summary title={t('settings.hooks.moreActions')} aria-label={t('settings.hooks.moreActions')}>
                  <span className="codicon codicon-ellipsis" aria-hidden="true" />
                </summary>
                <div className={styles.moreMenuPanel}>
                  <button type="button" onClick={onRestore} disabled={sourceLoading || mutationLoading}>
                    <span className="codicon codicon-history" aria-hidden="true" />
                    {t('settings.hooks.restore')}
                  </button>
                </div>
              </details>
            )}
            <button type="button" className={styles.secondaryButton} onClick={onRequestClose}>{t('common.cancel')}</button>
            <button type="button" className={styles.secondaryButton} onClick={onToggleDiff} disabled={sourceLoading || mutationLoading}>
              <span className="codicon codicon-diff" aria-hidden="true" />
              {showDiff ? t('settings.hooks.hideChanges') : t('settings.hooks.reviewChanges')}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onSave}
              disabled={sourceLoading || mutationLoading || !activeEditor || !showDiff || !hasDraftChanges
                || mutationError === 'HOOK_REVISION_CONFLICT' || Boolean(sourceError)}
            >
              <span className={`codicon ${mutationLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-save'}`} aria-hidden="true" />
              {mutationLoading ? t('settings.hooks.saving') : t('settings.hooks.save')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
