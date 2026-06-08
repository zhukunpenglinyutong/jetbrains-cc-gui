import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertIcon, TrashIcon } from '../Icons';

interface DiscardAllDialogProps {
  visible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const DiscardAllDialog = memo(({ visible, onConfirm, onCancel }: DiscardAllDialogProps) => {
  const { t } = useTranslation();

  if (!visible) return null;

  return (
    <div className="undo-confirm-overlay" onClick={onCancel}>
      <div className="undo-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="undo-confirm-header">
          <TrashIcon size={18} />
          <h3>{t('statusPanel.discardAllConfirmTitle')}</h3>
        </div>
        <div className="undo-confirm-body">
          <div className="undo-warning">
            <span className="warning-icon" aria-hidden="true">
              <AlertIcon size={18} />
            </span>
            <div className="warning-text">
              <p>{t('statusPanel.discardAllConfirmMessage')}</p>
            </div>
          </div>
        </div>
        <div className="undo-confirm-footer">
          <button className="cancel-btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="confirm-btn danger" onClick={onConfirm}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
});

DiscardAllDialog.displayName = 'DiscardAllDialog';

export default DiscardAllDialog;
