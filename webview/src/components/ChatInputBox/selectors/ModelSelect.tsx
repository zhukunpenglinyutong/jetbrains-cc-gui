import { useRef } from 'react';
import { AVAILABLE_MODELS } from '../types';
import type { ModelInfo } from '../types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { MODEL_ID_TO_MAPPING_KEY, resolveModelIdForIcon } from '../modelLabelUtils';
import { ModelDropdownContent } from './ModelDropdownContent';
import { useModelSelectState } from './useModelSelectState';
import {
  useModelDropdownLayout,
  useModelSelectHandlers,
  useModelSelectOutsideClick,
} from './useModelSelectDropdown';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  /** True while CLI providers (OpenCode / Kimi) are still fetching model catalogs. */
  loading?: boolean;
  /** Set when the CLI model catalog fetch failed (or timed out); row offers retry. */
  error?: string | null;
  /** Retries the CLI model catalog fetch for the current provider. */
  onRetry?: () => void;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  /** Render only the dropdown, positioned as a fly-out from triggerRef. */
  embedded?: boolean;
  /** Render the list flat inside a parent popover: no positioning, no close-on-select. */
  inline?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose?: () => void;
  /** Hide the 1M toggle when the parent menu already exposes it. */
  hideLongContextToggle?: boolean;
}

/**
 * ModelSelect - Model selector component
 * Supports switching between Sonnet 4.5, Opus 4.5, and other models, including Codex models
 */
export const ModelSelect = ({
  value,
  onChange,
  models = AVAILABLE_MODELS,
  currentProvider = 'claude',
  loading = false,
  error = null,
  onRetry,
  onAddModel,
  longContextEnabled = true,
  onLongContextChange,
  embedded = false,
  inline = false,
  triggerRef,
  onClose,
  hideLongContextToggle = false,
}: ModelSelectProps) => {
  const {
    t,
    isOpen,
    setIsOpen,
    searchQuery,
    setSearchQuery,
    pinnedIds,
    setPinnedIds,
    pinnedSet,
    currentModel,
    modelMapping,
    isSelectedModel,
    getModelLabel,
    getModelDescription,
    filteredModels,
    sections,
    hiddenModelCount,
    visibleModelCount,
    showSearch,
  } = useModelSelectState({ value, models, currentProvider, longContextEnabled });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { dropdownStyle, recalculate } = useModelDropdownLayout({
    embedded,
    inline,
    isOpen,
    loading,
    triggerRef,
    buttonRef,
    dropdownRef,
    filteredModelCount: filteredModels.length,
    pinnedCount: pinnedIds.length,
  });
  const {
    handleToggle,
    handleSelect,
    handleTogglePin,
    handleAddModel,
    resetSearchAndClose,
  } = useModelSelectHandlers({
    isOpen,
    inline,
    currentProvider,
    recalculate,
    onChange,
    onClose,
    onAddModel,
    setIsOpen,
    setSearchQuery,
    setPinnedIds,
  });
  useModelSelectOutsideClick({ embedded, isOpen, buttonRef, dropdownRef, resetSearchAndClose });

  const renderDropdown = () => (
    <ModelDropdownContent
      inline={inline}
      dropdownRef={dropdownRef}
      dropdownStyle={dropdownStyle}
      showSearch={showSearch}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      loading={loading}
      error={error}
      onRetry={onRetry}
      sections={sections}
      pinnedIds={pinnedSet}
      currentProvider={currentProvider}
      modelMapping={modelMapping}
      isSelectedModel={isSelectedModel}
      getModelLabel={getModelLabel}
      getModelDescription={getModelDescription}
      onSelect={handleSelect}
      onTogglePin={handleTogglePin}
      visibleModelCount={visibleModelCount}
      hiddenModelCount={hiddenModelCount}
      hideLongContextToggle={hideLongContextToggle}
      value={value}
      longContextEnabled={longContextEnabled}
      onLongContextChange={onLongContextChange}
      onAddModelClick={onAddModel ? handleAddModel : undefined}
    />
  );

  if (embedded || inline) {
    return renderDropdown();
  }

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={t('chat.currentModel', { model: getModelLabel(currentModel, true) })}
      >
        <ProviderModelIcon
          providerId={currentProvider}
          modelId={resolveModelIdForIcon(currentModel.id, currentProvider === 'claude' ? modelMapping : {}, MODEL_ID_TO_MAPPING_KEY)}
          size={12}
          colored
        />
        <span className="selector-button-text">{getModelLabel(currentModel, true)}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && renderDropdown()}
    </div>
  );
};

export default ModelSelect;
