import { useTranslation } from 'react-i18next';
import type { ClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { MODEL_ID_TO_MAPPING_KEY, resolveModelIdForIcon } from '../modelLabelUtils';
import type { ModelInfo } from '../types';

const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };

interface ModelConfigTriggerProps {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  isOpen: boolean;
  summaryText: string;
  currentModel: ModelInfo | undefined;
  currentProvider: string;
  modelMapping: ClaudeModelMapping;
  onToggle: (event: React.MouseEvent) => void;
}

/**
 * Summary trigger button for the model-settings selector: provider/model
 * icon, the combined summary text, and the open-state chevron.
 */
export const ModelConfigTrigger = ({
  buttonRef,
  isOpen,
  summaryText,
  currentModel,
  currentProvider,
  modelMapping,
  onToggle,
}: ModelConfigTriggerProps) => {
  const { t } = useTranslation();
  return (
    <button
      ref={buttonRef}
      type="button"
      className="selector-button model-config-button"
      onClick={onToggle}
      title={summaryText}
      aria-label={t('modelConfig.title', { defaultValue: 'Model settings' })}
      data-testid="model-config-trigger"
    >
      {currentModel && (
        <ProviderModelIcon
          providerId={currentProvider}
          modelId={resolveModelIdForIcon(
            currentModel.id,
            currentProvider === 'claude' ? modelMapping : {},
            MODEL_ID_TO_MAPPING_KEY,
          )}
          size={12}
          colored
        />
      )}
      <span className="selector-button-text model-config-summary-text">{summaryText}</span>
      <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
    </button>
  );
};
