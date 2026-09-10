import { useTranslation } from 'react-i18next';
import type { ModelInfo } from '../types';
import type { ClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import {
  MODEL_ID_TO_MAPPING_KEY,
  resolveModelIdForIcon,
} from '../modelLabelUtils';

const MODEL_OPTION_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODEL_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

interface ModelOptionRowProps {
  model: ModelInfo;
  currentProvider: string;
  modelMapping: ClaudeModelMapping;
  isSelected: boolean;
  isPinned: boolean;
  label: string;
  description?: string;
  onSelect: (modelId: string) => void;
  onTogglePin: (e: React.MouseEvent, modelId: string) => void;
}

/**
 * ModelOptionRow - A single selectable model row inside the model dropdown:
 * provider icon, label/description, pin toggle, and selection check mark.
 */
export const ModelOptionRow = ({
  model,
  currentProvider,
  modelMapping,
  isSelected,
  isPinned,
  label,
  description,
  onSelect,
  onTogglePin,
}: ModelOptionRowProps) => {
  const { t } = useTranslation();

  return (
    <div
      className={`selector-option ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelect(model.id)}
      data-testid={`model-option-${model.id}`}
    >
      <ProviderModelIcon
        providerId={currentProvider}
        modelId={resolveModelIdForIcon(model.id, currentProvider === 'claude' ? modelMapping : {}, MODEL_ID_TO_MAPPING_KEY)}
        size={16}
        colored
      />
      <div style={MODEL_OPTION_INFO_STYLE}>
        <span style={MODEL_TEXT_STYLE}>{label}</span>
        {description && (
          <span className="model-description" style={MODEL_TEXT_STYLE}>{description}</span>
        )}
      </div>
      <button
        type="button"
        className={`model-pin-button ${isPinned ? 'is-pinned' : ''}`}
        data-testid={`model-pin-${model.id}`}
        title={isPinned
          ? t('models.unpin', { defaultValue: 'Unpin' })
          : t('models.pin', { defaultValue: 'Pin' })}
        aria-label={isPinned
          ? t('models.unpin', { defaultValue: 'Unpin' })
          : t('models.pin', { defaultValue: 'Pin' })}
        onClick={(e) => onTogglePin(e, model.id)}
      >
        <span className={`codicon ${isPinned ? 'codicon-pinned' : 'codicon-pin'}`} />
      </button>
      {isSelected && (
        <span className="codicon codicon-check check-mark" />
      )}
    </div>
  );
};

export default ModelOptionRow;
