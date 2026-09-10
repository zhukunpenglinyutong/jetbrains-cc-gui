import { useTranslation } from 'react-i18next';
import {
  PRICING_FIELDS,
  isInvalidPricingValue,
  type PricingFieldKey,
} from './pricing';
import { MAX_CONTEXT_WINDOW_K } from './contextWindow';
import styles from './style.module.less';

const FLEX_1_STYLE: React.CSSProperties = { flex: 1 };
const DESC_INPUT_STYLE: React.CSSProperties = { width: '100%', marginBottom: '8px' };

interface ModelFormProps {
  isEditingConfiguredModel: boolean;
  isEditingAnyModel: boolean;
  contextWindowEnabled: boolean;
  newModelId: string;
  newModelLabel: string;
  newModelDesc: string;
  newContextWindowK: string;
  newPricingInputs: Record<PricingFieldKey, string>;
  modelIdError: string | null;
  contextWindowError: string | null;
  pricingError: string | null;
  pricingCollapsed: boolean;
  onModelIdChange: (value: string) => void;
  onModelLabelChange: (value: string) => void;
  onModelDescChange: (value: string) => void;
  onContextWindowKChange: (value: string) => void;
  onPricingInputChange: (key: PricingFieldKey, value: string) => void;
  onTogglePricingCollapsed: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}

/**
 * Add/edit form for a single custom model (or pricing-only edit for a
 * provider-configured model).
 */
export function ModelForm({
  isEditingConfiguredModel,
  isEditingAnyModel,
  contextWindowEnabled,
  newModelId,
  newModelLabel,
  newModelDesc,
  newContextWindowK,
  newPricingInputs,
  modelIdError,
  contextWindowError,
  pricingError,
  pricingCollapsed,
  onModelIdChange,
  onModelLabelChange,
  onModelDescChange,
  onContextWindowKChange,
  onPricingInputChange,
  onTogglePricingCollapsed,
  onCancel,
  onSubmit,
}: ModelFormProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.addEditForm} role="form" aria-label={isEditingAnyModel ? t('common.edit') : t('common.add')}>
      {isEditingConfiguredModel && (
        <p className={styles.sectionHint}>
          {t('settings.pluginModels.configuredEditHint')}
        </p>
      )}
      <div className={styles.formRow}>
        <label htmlFor="model-id-input" className="sr-only">
          {t('settings.codexProvider.dialog.modelIdPlaceholder')}
        </label>
        <input
          id="model-id-input"
          type="text"
          className={`form-input ${modelIdError ? 'input-error' : ''}`}
          placeholder={t('settings.codexProvider.dialog.modelIdPlaceholder')}
          value={newModelId}
          onChange={(e) => onModelIdChange(e.target.value)}
          style={FLEX_1_STYLE}
          autoFocus={!isEditingConfiguredModel}
          disabled={isEditingConfiguredModel}
          aria-invalid={!!modelIdError}
          aria-describedby={modelIdError ? 'model-id-error' : undefined}
        />
        <label htmlFor="model-label-input" className="sr-only">
          {t('settings.codexProvider.dialog.modelLabelPlaceholder')}
        </label>
        <input
          id="model-label-input"
          type="text"
          className="form-input"
          placeholder={t('settings.codexProvider.dialog.modelLabelPlaceholder')}
          value={newModelLabel}
          onChange={(e) => onModelLabelChange(e.target.value)}
          style={FLEX_1_STYLE}
          disabled={isEditingConfiguredModel}
        />
      </div>
      {modelIdError && (
        <div id="model-id-error" className={styles.validationError} role="alert">
          {modelIdError}
        </div>
      )}
      <label htmlFor="model-desc-input" className="sr-only">
        {t('settings.codexProvider.dialog.modelDescPlaceholder')}
      </label>
      <input
        id="model-desc-input"
        type="text"
        className="form-input"
        placeholder={t('settings.codexProvider.dialog.modelDescPlaceholder')}
        value={newModelDesc}
        onChange={(e) => onModelDescChange(e.target.value)}
        style={DESC_INPUT_STYLE}
        disabled={isEditingConfiguredModel}
      />

      {contextWindowEnabled && !isEditingConfiguredModel && (
        <div className={styles.contextWindowField}>
          <label htmlFor="model-context-window-input">
            {t('settings.pluginModels.contextWindow.label')}
          </label>
          <input
            id="model-context-window-input"
            type="number"
            min="1"
            max={MAX_CONTEXT_WINDOW_K}
            step="1"
            inputMode="numeric"
            className={`form-input ${contextWindowError ? 'input-error' : ''}`}
            placeholder={t('settings.pluginModels.contextWindow.placeholder')}
            value={newContextWindowK}
            onChange={(e) => onContextWindowKChange(e.target.value)}
            aria-invalid={!!contextWindowError}
            aria-describedby={contextWindowError
              ? 'model-context-window-hint model-context-window-error'
              : 'model-context-window-hint'}
          />
          <p id="model-context-window-hint" className={styles.fieldHint}>
            {t('settings.pluginModels.contextWindow.hint')}
          </p>
          {contextWindowError && (
            <div id="model-context-window-error" className={styles.validationError} role="alert">
              {contextWindowError}
            </div>
          )}
        </div>
      )}

      <div className={styles.pricingSection}>
        <button
          type="button"
          className={styles.pricingToggle}
          onClick={onTogglePricingCollapsed}
          aria-expanded={!pricingCollapsed}
          aria-controls="model-pricing-content"
        >
          <span
            className={`codicon ${pricingCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}`}
            aria-hidden="true"
          />
          <span className={styles.pricingToggleLabel}>
            {t('settings.pluginModels.pricing.title')}
          </span>
          <span className={styles.optionalBadge}>
            {t('settings.pluginModels.pricing.optionalLabel')}
          </span>
        </button>
        {!pricingCollapsed && (
          <div id="model-pricing-content" className={styles.pricingContent}>
            <p id="model-pricing-hint" className={styles.pricingHint}>
              {t('settings.pluginModels.pricing.hint')}
            </p>
            <div className={styles.pricingGrid}>
              {PRICING_FIELDS.map((field) => {
                const value = newPricingInputs[field.key];
                const invalid = isInvalidPricingValue(value);
                return (
                  <div key={field.key} className={styles.pricingField}>
                    <label htmlFor={`model-pricing-${field.key}`}>
                      {t(field.labelKey)}
                    </label>
                    <input
                      id={`model-pricing-${field.key}`}
                      type="number"
                      min="0"
                      step="0.000001"
                      inputMode="decimal"
                      className={`form-input ${invalid ? 'input-error' : ''}`}
                      placeholder={field.placeholder}
                      value={value}
                      onChange={(e) => onPricingInputChange(field.key, e.target.value)}
                      aria-invalid={invalid}
                      aria-describedby={pricingError ? 'model-pricing-hint model-pricing-error' : 'model-pricing-hint'}
                    />
                  </div>
                );
              })}
            </div>
            {pricingError && (
              <div id="model-pricing-error" className={styles.validationError} role="alert">
                {pricingError}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.formActions}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSubmit}
          disabled={!newModelId.trim()}
        >
          {isEditingAnyModel ? t('common.save') : t('common.add')}
        </button>
      </div>
    </div>
  );
}
