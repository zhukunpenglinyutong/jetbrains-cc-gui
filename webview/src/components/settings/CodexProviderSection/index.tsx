import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import styles from './style.module.less';

interface CodexProviderSectionProps {
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  showHeader?: boolean;
}

const CodexProviderSection = ({
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  showHeader = true,
}: CodexProviderSectionProps) => {
  const { t } = useTranslation();
  const [draggedProviderId, setDraggedProviderId] = useState<string | null>(null);
  const [dragOverProviderId, setDragOverProviderId] = useState<string | null>(null);
  const [localProviders, setLocalProviders] = useState<CodexProviderConfig[]>(codexProviders);

  // Sync localProviders from props (e.g. isActive changes pushed from backend)
  useEffect(() => {
    setLocalProviders(codexProviders);
  }, [codexProviders]);

  // Drag-and-drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, providerId: string) => {
    setDraggedProviderId(providerId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, providerId: string) => {
    e.preventDefault();
    if (draggedProviderId === null) return;
    if (draggedProviderId !== providerId) {
      setDragOverProviderId(providerId);
    }
  }, [draggedProviderId]);

  const handleDragLeave = useCallback(() => {
    setDragOverProviderId(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetProviderId: string) => {
    e.preventDefault();
    if (draggedProviderId === null || draggedProviderId === targetProviderId) {
      setDraggedProviderId(null);
      setDragOverProviderId(null);
      return;
    }

    const draggedIndex = localProviders.findIndex(p => p.id === draggedProviderId);
    const targetIndex = localProviders.findIndex(p => p.id === targetProviderId);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedProviderId(null);
      setDragOverProviderId(null);
      return;
    }

    const newOrder = [...localProviders];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, removed);

    // Optimistic update: reflect new order immediately without waiting for backend
    setLocalProviders(newOrder);

    sendToJava('sort_codex_providers', { orderedIds: newOrder.map(p => p.id) });

    setDraggedProviderId(null);
    setDragOverProviderId(null);
  }, [draggedProviderId, localProviders]);

  const handleDragEnd = useCallback(() => {
    setDraggedProviderId(null);
    setDragOverProviderId(null);
  }, []);

  return (
    <div className={styles.configSection}>
      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.codexProvider.title')}</h3>
          <p className={styles.sectionDesc}>{t('settings.codexProvider.description')}</p>
        </>
      )}

      {codexLoading && (
        <div className={styles.tempNotice}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('settings.provider.loading')}</p>
        </div>
      )}

      {!codexLoading && (
        <div className={styles.providerListContainer}>
          <div className={styles.providerListHeader}>
            <h4>{t('settings.provider.allProviders')}</h4>
            <button className="btn btn-primary" onClick={onAddCodexProvider}>
              <span className="codicon codicon-add" />
              {t('common.add')}
            </button>
          </div>

          <div className={styles.providerList}>
            {localProviders.length > 0 ? (
              localProviders.map((provider) => (
                <div
                  key={provider.id}
                  className={`${styles.providerCard} ${provider.isActive ? styles.active : ''} ${draggedProviderId === provider.id ? styles.dragging : ''} ${dragOverProviderId === provider.id ? styles.dragOver : ''}`}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, provider.id)}
                  onDragOver={(e) => handleDragOver(e, provider.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, provider.id)}
                  onDragEnd={handleDragEnd}
                >
                  <div className={styles.dragHandle} title={t('settings.provider.dragToSort')}>
                    <span className="codicon codicon-gripper" />
                  </div>
                  <div className={styles.providerInfo}>
                    <div className={styles.providerName}>{provider.name}</div>
                    {provider.remark && (
                      <div className={styles.providerRemark}>{provider.remark}</div>
                    )}
                  </div>

                  <div className={styles.providerActions}>
                    {provider.isActive ? (
                      <div className={styles.activeBadge}>
                        <span className="codicon codicon-check" />
                        {t('settings.provider.inUse')}
                      </div>
                    ) : (
                      <button
                        className={styles.useButton}
                        onClick={() => onSwitchCodexProvider(provider.id)}
                      >
                        <span className="codicon codicon-play" />
                        {t('settings.provider.enable')}
                      </button>
                    )}

                    <div className={styles.actionButtons}>
                      <button
                        className={styles.iconBtn}
                        onClick={() => onEditCodexProvider(provider)}
                        title={t('common.edit')}
                      >
                        <span className="codicon codicon-edit" />
                      </button>
                      <button
                        className={styles.iconBtn}
                        onClick={() => onDeleteCodexProvider(provider)}
                        title={t('common.delete')}
                      >
                        <span className="codicon codicon-trash" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className={styles.emptyState}>
                <span className="codicon codicon-info" />
                <p>{t('settings.codexProvider.emptyProvider')}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CodexProviderSection;
