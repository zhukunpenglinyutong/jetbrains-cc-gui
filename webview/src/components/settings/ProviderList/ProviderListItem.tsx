import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../../../types/provider';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
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
 * Pick the most representative configured model id for brand detection.
 * The base URL is the primary brand signal; the model id is only a fallback,
 * so any of the configured mapping models is sufficient.
 */
function pickModelId(provider: ProviderConfig): string | undefined {
  const env = provider.settingsConfig?.env;
  if (!env) return undefined;
  return (
    env.ANTHROPIC_DEFAULT_FABLE_MODEL
    || env.ANTHROPIC_MODEL
    || env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  );
}

interface ProviderListItemProps {
  provider: ProviderConfig;
  isDragging: boolean;
  isDragOver: boolean;
  onSwitch: (id: string) => void;
  onEdit: (provider: ProviderConfig) => void;
  onDelete: (provider: ProviderConfig) => void;
  onConvert: (provider: ProviderConfig) => void;
  handlePointerDown: (e: React.PointerEvent, id: string, previewElement?: HTMLElement | null) => void;
  handleDragStart: (e: React.DragEvent, id: string) => void;
  handleDragOver: (e: React.DragEvent, id: string) => void;
  handleDragLeave: () => void;
  handleDrop: (e: React.DragEvent, targetId: string) => void;
  handleDragEnd: () => void;
}

export default function ProviderListItem({
  provider,
  isDragging,
  isDragOver,
  onSwitch,
  onEdit,
  onDelete,
  onConvert,
  handlePointerDown,
  handleDragStart,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  handleDragEnd,
}: ProviderListItemProps) {
  const { t } = useTranslation();

  return (
    <div
      className={[
        styles.card,
        provider.isActive && styles.active,
        isDragging && styles.dragging,
        isDragOver && styles.dragOver,
      ].filter(Boolean).join(' ')}
      data-drag-sort-id={provider.id}
      draggable={true}
      onDragStart={(e) => handleDragStart(e, provider.id)}
      onDragOver={(e) => handleDragOver(e, provider.id)}
      onDragLeave={handleDragLeave}
      onDrop={(e) => handleDrop(e, provider.id)}
      onDragEnd={handleDragEnd}
    >
      <div
        className={styles.dragHandle}
        title={t('settings.provider.dragToSort')}
        onPointerDown={(e) => handlePointerDown(e, provider.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
      >
        <span className="codicon codicon-gripper" />
      </div>
      <div className={styles.cardInfo}>
        <div className={styles.name}>
          <span style={PROVIDER_LOGO_STYLE}>
            <ProviderModelIcon
              baseUrl={provider.settingsConfig?.env?.ANTHROPIC_BASE_URL}
              modelId={pickModelId(provider)}
              size={18}
              colored
            />
          </span>
          <span className={styles.nameText}>{provider.name}</span>
        </div>
        {(provider.remark || provider.websiteUrl) && (
          <div className={styles.website} title={provider.remark || provider.websiteUrl}>
            {provider.remark || provider.websiteUrl}
          </div>
        )}
        {provider.source === 'cc-switch' && (
            <div className={styles.ccSwitchBadge}>
                cc-switch
            </div>
        )}
      </div>

      <div className={styles.cardActions}>
        {provider.isActive ? (
          <div className={styles.activeBadge}>
            <span className="codicon codicon-check" />
            {t('settings.provider.inUse')}
          </div>
        ) : (
          <button
            className={styles.useButton}
            onClick={() => onSwitch(provider.id)}
          >
            <span className="codicon codicon-play" />
            {t('settings.provider.enable')}
          </button>
        )}

        <div className={styles.divider}></div>

        <div className={styles.actionButtons}>
          {!provider.isLocalProvider && (
            <>
              {provider.source === 'cc-switch' && (
                <button
                  className={styles.iconBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onConvert(provider);
                  }}
                  title={t('settings.provider.convertToPlugin')}
                >
                  <span className="codicon codicon-arrow-swap" />
                </button>
              )}
              <button
                className={styles.iconBtn}
                onClick={() => onEdit(provider)}
                title={t('common.edit')}
              >
                <span className="codicon codicon-edit" />
              </button>
              <button
                className={styles.iconBtn}
                onClick={() => onDelete(provider)}
                title={t('common.delete')}
              >
                <span className="codicon codicon-trash" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
