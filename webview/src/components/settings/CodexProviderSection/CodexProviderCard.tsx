import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import sharedStyles from '../ProviderList/style.module.less';
import styles from './style.module.less';

/**
 * Wraps a colored brand logo so it aligns with the provider name text and
 * never shrinks, matching the layout of the codicon used by the local/CLI cards.
 */
const PROVIDER_LOGO_STYLE: React.CSSProperties = {
  marginRight: '8px',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
};

/**
 * Extract the base_url and model from a Codex config.toml so the brand logo
 * can be resolved. Codex stores its endpoint config as raw TOML (rather than an
 * env object), so the brand is read from the `base_url` / `model` keys.
 * Returns the first occurrence of each key.
 */
function parseCodexConfigToml(configToml?: string): { baseUrl?: string; modelId?: string } {
  if (!configToml) return {};
  const baseUrlMatch = configToml.match(/^\s*base_url\s*=\s*"([^"]+)"/m);
  const modelMatch = configToml.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return {
    baseUrl: baseUrlMatch?.[1],
    modelId: modelMatch?.[1],
  };
}

interface CodexProviderCardProps {
  provider: CodexProviderConfig;
  draggedProviderId: string | null;
  dragOverProviderId: string | null;
  onPointerDown: (e: React.PointerEvent, id: string, previewElement?: HTMLElement | null) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, targetId: string) => void;
  onDragEnd: () => void;
  onSwitchCodexProvider: (id: string) => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
}

const CodexProviderCard = ({
  provider,
  draggedProviderId,
  dragOverProviderId,
  onPointerDown,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onSwitchCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
}: CodexProviderCardProps) => {
  const { t } = useTranslation();

  return (
    <div
      className={[
        sharedStyles.card,
        provider.isActive && sharedStyles.active,
        draggedProviderId === provider.id && styles.dragging,
        dragOverProviderId === provider.id && styles.dragOver,
      ].filter(Boolean).join(' ')}
      data-drag-sort-id={provider.id}
      draggable={true}
      onDragStart={(e) => onDragStart(e, provider.id)}
      onDragOver={(e) => onDragOver(e, provider.id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, provider.id)}
      onDragEnd={onDragEnd}
    >
      <div
        className={sharedStyles.dragHandle}
        title={t('settings.provider.dragToSort')}
        onPointerDown={(e) => onPointerDown(e, provider.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
      >
        <span className="codicon codicon-gripper" />
      </div>
      <div className={sharedStyles.cardInfo}>
        <div className={sharedStyles.name}>
          {(() => {
            const { baseUrl, modelId } = parseCodexConfigToml(provider.configToml);
            return (
              <span style={PROVIDER_LOGO_STYLE}>
                <ProviderModelIcon
                  baseUrl={baseUrl}
                  modelId={modelId}
                  size={18}
                  colored
                />
              </span>
            );
          })()}
          <span className={sharedStyles.nameText}>{provider.name}</span>
        </div>
        {provider.remark && (
          <div className={sharedStyles.website}>{provider.remark}</div>
        )}
      </div>

      <div className={sharedStyles.cardActions}>
        {provider.isActive ? (
          <div className={sharedStyles.activeBadge}>
            <span className="codicon codicon-check" />
            {t('settings.provider.inUse')}
          </div>
        ) : (
          <button
            className={sharedStyles.useButton}
            onClick={() => onSwitchCodexProvider(provider.id)}
          >
            <span className="codicon codicon-play" />
            {t('settings.provider.enable')}
          </button>
        )}

        <div className={sharedStyles.divider} />

        <div className={sharedStyles.actionButtons}>
          <button
            className={sharedStyles.iconBtn}
            onClick={() => onEditCodexProvider(provider)}
            title={t('common.edit')}
          >
            <span className="codicon codicon-edit" />
          </button>
          <button
            className={sharedStyles.iconBtn}
            onClick={() => onDeleteCodexProvider(provider)}
            title={t('common.delete')}
          >
            <span className="codicon codicon-trash" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default CodexProviderCard;
