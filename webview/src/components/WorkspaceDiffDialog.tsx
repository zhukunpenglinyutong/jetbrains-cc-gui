import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useCodexWorkspaceDiff } from '../hooks/useCodexWorkspaceDiff';
import { parseWorkspaceDiffSnapshot, type WorkspaceDiffFile } from '../utils/workspaceDiffFiles';
import './WorkspaceDiffDialog.css';

const FILE_KIND_ICONS: Record<WorkspaceDiffFile['kind'], string> = {
  add: 'codicon-diff-added',
  delete: 'codicon-diff-removed',
  rename: 'codicon-diff-renamed',
  modify: 'codicon-diff-modified',
};

/** Shows the /diff workspace snapshot pushed by CodexWorkspaceDiffHandler. */
const WorkspaceDiffDialog = () => {
  const { t } = useTranslation();
  const { open, result, close, refresh } = useCodexWorkspaceDiff();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const snapshot = useMemo(
    () => (open && result ? parseWorkspaceDiffSnapshot(result) : null),
    [open, result],
  );

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', handleEscape);
    closeButtonRef.current?.focus();
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, close]);

  if (!open || !result) {
    return null;
  }

  const renderFileSection = (heading: string, files: WorkspaceDiffFile[]) => {
    if (!files.length) return null;
    return (
      <div className="workspace-diff-section">
        <h4 className="workspace-diff-section-title">
          {heading}
          <span className="workspace-diff-count">{t('workspaceDiff.fileCount', { count: files.length })}</span>
        </h4>
        <ul className="workspace-diff-list">
          {files.map((file, index) => (
            <li key={`${file.path}:${index}`} className="workspace-diff-file">
              <span className={`codicon ${FILE_KIND_ICONS[file.kind]}`} />
              <span className="workspace-diff-path" title={file.path}>{file.path}</span>
              {file.binary && <span className="workspace-diff-badge">{t('workspaceDiff.binary')}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const renderUntrackedSection = () => {
    if (!snapshot?.untracked.length) return null;
    return (
      <div className="workspace-diff-section">
        <h4 className="workspace-diff-section-title">
          {t('workspaceDiff.untracked')}
          <span className="workspace-diff-count">
            {t('workspaceDiff.fileCount', { count: snapshot.untracked.length })}
          </span>
        </h4>
        <ul className="workspace-diff-list">
          {snapshot.untracked.map((path, index) => (
            <li key={`${path}:${index}`} className="workspace-diff-file">
              <span className="codicon codicon-new-file" />
              <span className="workspace-diff-path" title={path}>{path}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const hasChanges = snapshot
    && (snapshot.staged.length > 0 || snapshot.unstaged.length > 0 || snapshot.untracked.length > 0);

  return createPortal(
    <div className="confirm-dialog-overlay" onClick={close}>
      <div className="confirm-dialog workspace-diff-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">
          <span className="codicon codicon-diff" />
          <h3 className="confirm-dialog-title">{t('workspaceDiff.title')}</h3>
          <button className="confirm-dialog-button workspace-diff-refresh" onClick={refresh}>
            <span className="codicon codicon-refresh" />
            {t('workspaceDiff.refresh')}
          </button>
        </div>
        <div className="confirm-dialog-body workspace-diff-body">
          {result.repository === false ? (
            <p className="workspace-diff-error">
              {result.error || t('workspaceDiff.notGit')}
            </p>
          ) : (
            <>
              {result.root && (
                <p className="workspace-diff-root" title={result.root}>
                  <span className="codicon codicon-repo" />
                  {result.root}
                </p>
              )}
              {result.error && <p className="workspace-diff-error">{result.error}</p>}
              {result.truncated && <p className="workspace-diff-warning">{t('workspaceDiff.truncated')}</p>}
              {hasChanges ? (
                <>
                  {renderFileSection(t('workspaceDiff.staged'), snapshot!.staged)}
                  {renderFileSection(t('workspaceDiff.unstaged'), snapshot!.unstaged)}
                  {renderUntrackedSection()}
                </>
              ) : (
                <p className="workspace-diff-empty">{t('workspaceDiff.noChanges')}</p>
              )}
            </>
          )}
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-button confirm-button" onClick={close} ref={closeButtonRef}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default WorkspaceDiffDialog;
