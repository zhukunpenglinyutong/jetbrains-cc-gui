import { useTranslation } from 'react-i18next';
import type { CodexCustomModel } from '../../../types/provider';
import { formatPricingSummary, hasPricing } from './pricing';
import styles from './style.module.less';

interface ConfiguredModelsSectionProps {
  models: CodexCustomModel[];
  onEditPricing: (model: CodexCustomModel) => void;
}

/**
 * Read-only list of provider/settings-configured models; only pricing is editable.
 */
export function ConfiguredModelsSection({ models, onEditPricing }: ConfiguredModelsSectionProps) {
  const { t } = useTranslation();

  if (models.length === 0) {
    return null;
  }

  return (
    <section className={styles.configuredModelsSection} aria-labelledby="configured-models-heading">
      <h4 id="configured-models-heading" className={styles.sectionHeader}>
        {t('settings.pluginModels.configuredSectionTitle')}
      </h4>
      <p className={styles.sectionHint}>
        {t('settings.pluginModels.configuredSectionDesc')}
      </p>
      <div className={styles.modelList} role="list" aria-label={t('settings.pluginModels.configuredSectionTitle')}>
        {models.map((model) => (
          <div key={model.id} className={styles.modelItem} role="listitem">
            <div className={styles.modelItemContent}>
              <div className={styles.modelItemId}>{model.id}</div>
              {model.label && model.label !== model.id && (
                <span className={styles.modelItemLabel}>
                  ({model.label})
                </span>
              )}
              {model.description && (
                <div className={styles.modelItemDesc}>
                  {model.description}
                </div>
              )}
              <div className={styles.modelItemPricing}>
                {hasPricing(model.pricing)
                  ? formatPricingSummary(model.pricing, t)
                  : t('settings.pluginModels.pricing.defaultPricing')}
              </div>
            </div>
            <div className={styles.modelItemActions}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => onEditPricing(model)}
                title={t('settings.pluginModels.editPricing')}
                aria-label={`${t('settings.pluginModels.editPricing')} ${model.id}`}
              >
                <span className="codicon codicon-edit" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
