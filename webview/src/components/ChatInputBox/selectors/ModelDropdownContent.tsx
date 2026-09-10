import type { ModelInfo } from '../types';
import type { ClaudeModelMapping } from '../../../utils/claudeModelMapping';
import type { ModelGroup } from '../modelSelectUtils';
import { ModelSearchRow } from './ModelSearchRow';
import { ModelStatusRows } from './ModelStatusRows';
import { ModelSection } from './ModelSection';
import { ModelListHints } from './ModelListHints';
import { LongContextRow } from './LongContextRow';
import { AddModelRow } from './AddModelRow';

const DROPDOWN_LIST_STYLE: React.CSSProperties = { overflowY: 'auto', flex: 1, minHeight: 0 };

interface ModelDropdownContentProps {
  /** Render the list flat inside a parent popover: no positioning, no close-on-select. */
  inline: boolean;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  dropdownStyle: React.CSSProperties;
  showSearch: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  sections: ModelGroup[];
  pinnedIds: ReadonlySet<string>;
  currentProvider: string;
  modelMapping: ClaudeModelMapping;
  isSelectedModel: (modelId: string) => boolean;
  getModelLabel: (model: ModelInfo, show1MContext?: boolean) => string;
  getModelDescription: (model: ModelInfo) => string | undefined;
  onSelect: (modelId: string) => void;
  onTogglePin: (e: React.MouseEvent, modelId: string) => void;
  visibleModelCount: number;
  hiddenModelCount: number;
  hideLongContextToggle: boolean;
  value: string;
  longContextEnabled: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  /** Runs the add-model flow (also closes the dropdown); absence hides the row. */
  onAddModelClick?: () => void;
}

/**
 * ModelDropdownContent - The model dropdown panel: search row, status rows,
 * grouped/pinned model sections, hidden-count hint, 1M context toggle, and
 * the add-model action.
 */
export const ModelDropdownContent = ({
  inline,
  dropdownRef,
  dropdownStyle,
  showSearch,
  searchQuery,
  onSearchQueryChange,
  loading,
  error,
  onRetry,
  sections,
  pinnedIds,
  currentProvider,
  modelMapping,
  isSelectedModel,
  getModelLabel,
  getModelDescription,
  onSelect,
  onTogglePin,
  visibleModelCount,
  hiddenModelCount,
  hideLongContextToggle,
  value,
  longContextEnabled,
  onLongContextChange,
  onAddModelClick,
}: ModelDropdownContentProps) => {
  return (
    <div
      ref={dropdownRef}
      className={inline ? 'model-selector-inline' : 'selector-dropdown model-selector-dropdown'}
      data-testid="model-selector-dropdown"
      style={inline ? undefined : dropdownStyle}
      onMouseEnter={(e) => e.stopPropagation()}
    >
      {showSearch && (
        <ModelSearchRow
          searchQuery={searchQuery}
          onSearchQueryChange={onSearchQueryChange}
        />
      )}
      <div className={inline ? 'model-selector-list model-selector-list--inline' : 'model-selector-list'} style={DROPDOWN_LIST_STYLE}>
        <ModelStatusRows loading={loading} error={error} onRetry={onRetry} />
        {sections.map((section) => (
          <ModelSection
            key={section.id}
            section={section}
            pinnedIds={pinnedIds}
            currentProvider={currentProvider}
            modelMapping={modelMapping}
            isSelectedModel={isSelectedModel}
            getModelLabel={getModelLabel}
            getModelDescription={getModelDescription}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
          />
        ))}
        <ModelListHints
          loading={loading}
          visibleModelCount={visibleModelCount}
          hiddenModelCount={hiddenModelCount}
        />
        <LongContextRow
          hideLongContextToggle={hideLongContextToggle}
          currentProvider={currentProvider}
          value={value}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
        />
        <AddModelRow onAddModelClick={onAddModelClick} />
      </div>
    </div>
  );
};

export default ModelDropdownContent;
