import { useTranslation } from 'react-i18next';

interface ModelSearchRowProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}

/**
 * ModelSearchRow - The sticky search input at the top of the model dropdown.
 */
export const ModelSearchRow = ({
  searchQuery,
  onSearchQueryChange,
}: ModelSearchRowProps) => {
  const { t } = useTranslation();

  return (
    <div className="selector-search-row selector-search-row--sticky">
      <input
        className="selector-search-input"
        data-testid="model-search-input"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        placeholder={t('models.searchPlaceholder', { defaultValue: 'Search models' })}
        autoFocus
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
};

export default ModelSearchRow;
