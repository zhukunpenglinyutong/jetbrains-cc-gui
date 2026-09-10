import { useTranslation } from 'react-i18next';

interface ModelListHintsProps {
  loading: boolean;
  visibleModelCount: number;
  hiddenModelCount: number;
}

/**
 * ModelListHints - The trailing hints of the model dropdown: the empty-result
 * message and the hidden-model-count line.
 */
export const ModelListHints = ({
  loading,
  visibleModelCount,
  hiddenModelCount,
}: ModelListHintsProps) => {
  const { t } = useTranslation();

  return (
    <>
      {visibleModelCount === 0 && !loading && (
        <div className="selector-option selector-option-status">
          {t('models.noModelsFound', { defaultValue: 'No models found' })}
        </div>
      )}
      {hiddenModelCount > 0 && (
        <div className="selector-option selector-option-status" data-testid="model-hidden-count">
          {t('models.hiddenModelCount', {
            count: hiddenModelCount,
            defaultValue: `+ ${hiddenModelCount} more models. Type to search.`,
          })}
        </div>
      )}
    </>
  );
};

export default ModelListHints;
