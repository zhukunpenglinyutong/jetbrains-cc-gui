import { useTranslation } from 'react-i18next';
import type { CodexCustomModel } from '../../../types/provider';
import { formatPricingSummary, hasPricing } from './pricing';
import styles from './style.module.less';

interface CustomModelsSectionProps {
  models: CodexCustomModel[];
  isAdding: boolean;
  contextWindowEnabled: boolean;
  onEdit: (model: CodexCustomModel) => void;
  onRemove: (id: string) => void;
}

/**
 * Editable list of plugin-level custom models with edit/remove actions.
 */
export function CustomModelsSection({
  models,
  isAdding,
  contextWindowEnabled,
  onEdit,
  onRemove,
}: CustomModelsSectionProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="custom-models-heading">
      <h4 id="custom-models-heading" className={styles.sectionHeader}>
        {t('settings.pluginModels.customSectionTitle')}
      </h4>
      <div className={styles.modelList} role="list" aria-label={t('settings.pluginModels.customSectionTitle')}>
        {models.length === 0 && !isAdding ? (
          <div className={styles.emptyState} role="status">
            {t('settings.codexProvider.dialog.noCustomModels')}
          </div>
        ) : (
          models.map((model) => (
            <div key={model.id} className={styles.modelItem} role="listitem">
              <div className={styles.modelItemContent}>
                <div className={styles.modelItemId}>{model.id}</div>
                {model.label !== model.id && (
                  <span className={styles.modelItemLabel}>
                    ({model.label})
                  </span>
                )}
                {model.description && (
                  <div className={styles.modelItemDesc}>
                    {model.description}
                  </div>
                )}
                {contextWindowEnabled && model.contextWindowTokens !== undefined && (
                  <div className={styles.modelItemMetadata}>
                    {t('settings.pluginModels.contextWindow.summary', {
                      value: model.contextWindowTokens.toLocaleString(),
                      defaultValue: 'Context: {{value}} tokens',
                    })}
                  </div>
                )}
                {hasPricing(model.pricing) && (
                  <div className={styles.modelItemPricing}>
                    {formatPricingSummary(model.pricing, t)}
                  </div>
                )}
              </div>
              <div className={styles.modelItemActions}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => onEdit(model)}
                  title={t('common.edit')}
                  aria-label={`${t('common.edit')} ${model.id}`}
                >
                  <span className="codicon codicon-edit" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.iconBtnDanger}
                  onClick={() => onRemove(model.id)}
                  title={t('common.delete')}
                  aria-label={`${t('common.delete')} ${model.id}`}
                >
                  <span className="codicon codicon-trash" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
