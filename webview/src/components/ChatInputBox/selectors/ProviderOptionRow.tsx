import { useTranslation } from 'react-i18next';
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
  /** Floating panel rendered inside the Codex row (e.g. the quota submenu). */
  trailingPanel?: React.ReactNode;
  onSelect: (providerId: string) => void;
  onRowMouseEnter: (e: React.MouseEvent<HTMLDivElement>, providerId: string) => void;
  onRowMouseLeave: (providerId: string) => void;
}

/**
 * ProviderOptionRow - a single provider entry inside the provider dropdown
 */
export const ProviderOptionRow = ({
  provider,
  isSelected,
  label,
  trailingPanel,
  onSelect,
  onRowMouseEnter,
  onRowMouseLeave,
}: ProviderOptionRowProps) => {
  const { t } = useTranslation();

  return (
    <div
      className={`selector-option ${isSelected ? 'selected' : ''} ${!provider.enabled ? 'disabled' : ''}`}
      onClick={() => onSelect(provider.id)}
      style={{
        ...getProviderOptionStyle(!!provider.enabled),
        ...(provider.id === 'codex' ? { position: 'relative' } : {}),
      }}
      data-provider-id={provider.id}
      onMouseEnter={(e) => onRowMouseEnter(e, provider.id)}
      onMouseLeave={() => onRowMouseLeave(provider.id)}
    >
      <ProviderModelIcon providerId={provider.id} size={16} colored />
      <span>{label}</span>
      <span className="provider-option-trailing">
        {isSelected && (
          <span className="provider-active-dot" aria-hidden="true" />
        )}
        {provider.beta && (
          <span className="provider-beta-badge">
            {t('providers.beta.badge', { defaultValue: 'Beta' })}
          </span>
        )}
        {provider.id === 'codex' && (
          <span
            className="codicon codicon-chevron-right"
            style={{ fontSize: '10px' }}
          />
        )}
      </span>
      {provider.id === 'codex' && trailingPanel}
    </div>
  );
};

export default ProviderOptionRow;
