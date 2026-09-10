import { useTranslation } from 'react-i18next';

const LOADING_OPTION_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'default',
};

interface ModelStatusRowsProps {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}

/**
 * ModelStatusRows - The loading and load-error status rows shown above the
 * grouped model sections while the model list is (re)loading.
 */
export const ModelStatusRows = ({
  loading,
  error,
  onRetry,
}: ModelStatusRowsProps) => {
  const { t } = useTranslation();

  return (
    <>
      {loading && (
        <div
          className="selector-option selector-option-status"
          data-testid="model-loading"
          style={LOADING_OPTION_STYLE}
        >
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('chat.loadingDropdown')}</span>
        </div>
      )}
      {!loading && error && (
        <div
          className="selector-option selector-option-status"
          data-testid="model-load-error"
          style={{ ...LOADING_OPTION_STYLE, cursor: onRetry ? 'pointer' : 'default' }}
          title={error}
          onClick={() => onRetry?.()}
        >
          <span className="codicon codicon-warning" />
          <span style={{ flex: 1, minWidth: 0 }}>{t('chat.modelsLoadFailed')}</span>
          <span className="codicon codicon-refresh" />
        </div>
      )}
    </>
  );
};

export default ModelStatusRows;
