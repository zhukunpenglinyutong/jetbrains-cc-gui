import type { ProviderInfo } from '../types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';

function getProviderOptionStyle(enabled: boolean): React.CSSProperties {
  return {
    opacity: enabled ? 1 : 0.5,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

interface ProviderOptionRowProps {
  provider: ProviderInfo;
  isSelected: boolean;
  label: string;
  onSelect: (providerId: string) => void;
  onActivate: (providerId: string) => void;
  quotaId?: string;
}

/**
 * ProviderOptionRow - a single provider entry inside the provider dropdown
 */
export const ProviderOptionRow = ({
  provider,
  isSelected,
  label,
  onSelect,
  onActivate,
  quotaId,
}: ProviderOptionRowProps) => {
  return (
    <div
      className={`selector-option ${isSelected ? 'selected' : ''} ${!provider.enabled ? 'disabled' : ''}`}
      role="menuitemradio"
      aria-checked={isSelected}
      aria-disabled={!provider.enabled || undefined}
      aria-describedby={provider.id === 'codex' ? quotaId : undefined}
      tabIndex={-1}
      onClick={() => onSelect(provider.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onSelect(provider.id);
        }
      }}
      style={getProviderOptionStyle(!!provider.enabled)}
      data-provider-id={provider.id}
      onFocus={() => onActivate(provider.id)}
      onMouseEnter={() => {
        // Reaching quota above or below the menu can require crossing other rows.
        if (provider.id === 'codex') onActivate(provider.id);
      }}
    >
      <ProviderModelIcon providerId={provider.id} size={16} colored />
      <span>{label}</span>
      <span className="provider-option-trailing">
        {isSelected && (
          <span className="provider-active-dot" aria-hidden="true" />
        )}
        {provider.id === 'codex' && (
          <span
            className="codicon codicon-chevron-right"
            style={{ fontSize: '10px' }}
          />
        )}
      </span>
    </div>
  );
};

export default ProviderOptionRow;
