import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexCustomModel, ModelPricing } from '../../../types/provider';
// Model ID format is intentionally not restricted — see isValidModelId() JSDoc for rationale
import { ConfiguredModelsSection } from './ConfiguredModelsSection';
import { CustomModelsSection } from './CustomModelsSection';
import { ModelForm } from './ModelForm';
import { useModelForm } from './useModelForm';
import styles from './style.module.less';

const DIALOG_STYLE: React.CSSProperties = { maxWidth: '640px' };
const ADD_ICON_STYLE: React.CSSProperties = { marginRight: '4px' };

interface CustomModelDialogProps {
  isOpen: boolean;
  models: CodexCustomModel[];
  onModelsChange: (models: CodexCustomModel[]) => void;
  /** Models from Claude provider/settings mappings. They are already selectable; only pricing is editable here. */
  configuredModels?: CodexCustomModel[];
  onConfiguredModelPricingChange?: (modelId: string, pricing?: ModelPricing) => void;
  onClose: () => void;
  /** Enables Codex-only context-window metadata editing. */
  contextWindowEnabled?: boolean;
  /** If provided, opens in add-model mode directly */
  initialAddMode?: boolean;
}

/**
 * Custom Model Management Dialog
 * Full CRUD for plugin-level custom models in a modal dialog
 */
export function CustomModelDialog({
  isOpen,
  models,
  onModelsChange,
  configuredModels = [],
  onConfiguredModelPricingChange,
  onClose,
  contextWindowEnabled = false,
  initialAddMode = false,
}: CustomModelDialogProps) {
  const { t } = useTranslation();
  const form = useModelForm({
    isOpen,
    models,
    onModelsChange,
    onConfiguredModelPricingChange,
    contextWindowEnabled,
    initialAddMode,
  });

  // ESC key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleRemoveModel = useCallback((id: string) => {
    onModelsChange(models.filter(m => m.id !== id));
  }, [models, onModelsChange]);

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog provider-dialog" style={DIALOG_STYLE}>
        <div className="dialog-header">
          <h3>{t('settings.pluginModels.dialogTitle')}</h3>
          <button type="button" className="close-btn" onClick={onClose} title={t('common.close')}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">{t('settings.pluginModels.description')}</p>

          <ConfiguredModelsSection
            models={configuredModels}
            onEditPricing={form.handleEditConfiguredModelPricing}
          />

          <CustomModelsSection
            models={models}
            isAdding={form.isAdding}
            contextWindowEnabled={contextWindowEnabled}
            onEdit={form.handleEditModel}
            onRemove={handleRemoveModel}
          />

          {/* Add/edit form */}
          {form.isAdding ? (
            <ModelForm
              isEditingConfiguredModel={form.isEditingConfiguredModel}
              isEditingAnyModel={form.isEditingAnyModel}
              contextWindowEnabled={contextWindowEnabled}
              newModelId={form.newModelId}
              newModelLabel={form.newModelLabel}
              newModelDesc={form.newModelDesc}
              newContextWindowK={form.newContextWindowK}
              newPricingInputs={form.newPricingInputs}
              modelIdError={form.modelIdError}
              contextWindowError={form.contextWindowError}
              pricingError={form.pricingError}
              pricingCollapsed={form.pricingCollapsed}
              onModelIdChange={form.handleModelIdChange}
              onModelLabelChange={form.setNewModelLabel}
              onModelDescChange={form.setNewModelDesc}
              onContextWindowKChange={form.handleContextWindowKChange}
              onPricingInputChange={form.handlePricingInputChange}
              onTogglePricingCollapsed={form.handleTogglePricingCollapsed}
              onCancel={form.handleCancelEdit}
              onSubmit={form.handleSubmitForm}
            />
          ) : (
            <button
              type="button"
              className={`btn btn-secondary btn-sm ${styles.addBtn}`}
              onClick={form.startAdd}
              aria-label={t('settings.codexProvider.dialog.addModel')}
            >
              <span className="codicon codicon-add" aria-hidden="true" style={ADD_ICON_STYLE} />
              {t('settings.codexProvider.dialog.addModel')}
            </button>
          )}
        </div>

        <div className="dialog-footer">
          <div className={styles.dialogFooterSpacer} />
          <div className="footer-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CustomModelDialog;
