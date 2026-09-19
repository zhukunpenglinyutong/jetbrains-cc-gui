import { useTranslation } from 'react-i18next';

interface AddModelRowProps {
  /** Runs the add-model flow (also closes the dropdown); absence hides the row. */
  onAddModelClick?: () => void;
}

/**
 * AddModelRow - The "add model" action row at the bottom of the model dropdown.
 */
export const AddModelRow = ({ onAddModelClick }: AddModelRowProps) => {
  const { t } = useTranslation();

  if (!onAddModelClick) {
    return null;
  }

  return (
    <>
      <div className="selector-divider" />
      <div
        className="selector-option selector-option-add"
        role="button"
        tabIndex={0}
        onClick={onAddModelClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onAddModelClick();
          }
        }}
      >
        <span className="codicon codicon-add selector-add-icon" />
        <span>{t('models.addModel')}</span>
      </div>
    </>
  );
};

export default AddModelRow;
