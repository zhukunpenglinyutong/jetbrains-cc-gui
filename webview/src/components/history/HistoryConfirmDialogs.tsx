import { memo } from 'react';
import type { TFunction } from 'i18next';
import { stopPropagationHandler } from './HistoryListItem';

export interface HistoryConfirmDialogsProps {
  deletingSessionId: string | null;
  convertingSessionId: string | null;
  isDeletingSelected: boolean;
  selectedCount: number;
  t: TFunction;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onCancelConvert: () => void;
  onConfirmConvert: () => void;
  onCancelDeleteSelected: () => void;
  onConfirmDeleteSelected: () => void;
}

export const HistoryConfirmDialogs = memo(({
  deletingSessionId,
  convertingSessionId,
  isDeletingSelected,
  selectedCount,
  t,
  onCancelDelete,
  onConfirmDelete,
  onCancelConvert,
  onConfirmConvert,
  onCancelDeleteSelected,
  onConfirmDeleteSelected,
}: HistoryConfirmDialogsProps) => {
  return (
    <>
      {/* Delete confirmation dialog */}
      {deletingSessionId && (
        <div className="modal-overlay" onClick={onCancelDelete} role="presentation">
          <div className="modal-content" onClick={stopPropagationHandler}>
            <h3>{t('history.confirmDelete')}</h3>
            <p>{t('history.deleteMessage')}</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={onCancelDelete}>
                {t('common.cancel')}
              </button>
              <button className="modal-btn modal-btn-danger" onClick={onConfirmDelete}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Convert to CLI confirmation dialog */}
      {convertingSessionId && (
        <div className="modal-overlay" onClick={onCancelConvert} role="presentation">
          <div className="modal-content" onClick={stopPropagationHandler} role="dialog" aria-modal="true" aria-labelledby="convert-session-title">
            <h3 id="convert-session-title">{t('history.confirmConvert')}</h3>
            <p>{t('history.convertConfirmMessage')}</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={onCancelConvert}>
                {t('common.cancel')}
              </button>
              <button className="modal-btn modal-btn-primary" onClick={onConfirmConvert}>
                {t('history.convertButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isDeletingSelected && (
        <div className="modal-overlay" onClick={onCancelDeleteSelected} role="presentation">
          <div className="modal-content" onClick={stopPropagationHandler} role="dialog" aria-modal="true" aria-labelledby="delete-selected-title">
            <h3 id="delete-selected-title">{t('history.confirmDeleteSelected')}</h3>
            <p>{t('history.deleteSelectedMessage', { count: selectedCount })}</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={onCancelDeleteSelected}>
                {t('common.cancel')}
              </button>
              <button className="modal-btn modal-btn-danger" onClick={onConfirmDeleteSelected}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

HistoryConfirmDialogs.displayName = 'HistoryConfirmDialogs';
