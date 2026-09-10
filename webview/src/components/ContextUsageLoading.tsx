import { useTranslation } from 'react-i18next';

interface ContextUsageLoadingProps {
  dialogRef: React.RefObject<HTMLDivElement | null>;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  titleId: string;
  descriptionId: string;
  onCloseMouseDown: (e: React.MouseEvent) => void;
  onCloseClick: (e: React.MouseEvent) => void;
  onDialogMouseDown: (e: React.MouseEvent) => void;
}

export function ContextUsageLoading({
  dialogRef,
  closeButtonRef,
  titleId,
  descriptionId,
  onCloseMouseDown,
  onCloseClick,
  onDialogMouseDown,
}: ContextUsageLoadingProps) {
  const { t } = useTranslation();

  return (
    <div className="context-usage-overlay" onMouseDown={onCloseMouseDown}>
      <div
        className="context-usage-dialog context-usage-loading"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onMouseDown={onDialogMouseDown}
      >
        <div className="context-usage-header">
          <h3 id={titleId} className="context-usage-title">
            {t('contextUsage.title', { defaultValue: 'Context Usage' })}
          </h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="context-usage-close"
            onMouseDown={onCloseMouseDown}
            onClick={onCloseClick}
            title={t('common.close', { defaultValue: 'Close' })}
            aria-label={t('common.close', { defaultValue: 'Close' })}
          >
            ×
          </button>
        </div>
        <div className="context-usage-loading-body">
          <div className="context-usage-spinner" />
          <span id={descriptionId} className="context-usage-loading-text">
            {t('contextUsage.loading', { defaultValue: 'Loading context usage...' })}
          </span>
        </div>
      </div>
    </div>
  );
}
