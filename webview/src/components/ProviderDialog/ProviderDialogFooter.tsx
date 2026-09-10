import { useTranslation } from 'react-i18next';

const FOOTER_ACTIONS_STYLE: React.CSSProperties = { marginLeft: 'auto' };

interface ProviderDialogFooterProps {
  isAdding: boolean;
  onClose: () => void;
  onSave: () => void;
}

export default function ProviderDialogFooter({
  isAdding,
  onClose,
  onSave,
}: ProviderDialogFooterProps) {
  const { t } = useTranslation();

  return (
    <div className="dialog-footer">
      <div className="footer-actions" style={FOOTER_ACTIONS_STYLE}>
        <button className="btn btn-secondary" onClick={onClose}>
          <span className="codicon codicon-close" />
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" onClick={onSave}>
          <span className="codicon codicon-save" />
          {isAdding ? t('settings.provider.dialog.confirmAdd') : t('settings.provider.dialog.saveChanges')}
        </button>
      </div>
    </div>
  );
}
