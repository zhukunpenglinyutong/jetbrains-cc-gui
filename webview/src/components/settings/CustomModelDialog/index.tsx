import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexCustomModel } from '../../../types/provider';
import { isValidModelId } from '../../../types/provider';
import styles from './style.module.less';

interface CustomModelDialogProps {
  isOpen: boolean;
  models: CodexCustomModel[];
  onModelsChange: (models: CodexCustomModel[]) => void;
  onClose: () => void;
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
  onClose,
  initialAddMode = false,
}: CustomModelDialogProps) {
  const { t } = useTranslation();

  // Form state
  const [isAdding, setIsAdding] = useState(false);
  const [editingModel, setEditingModel] = useState<CodexCustomModel | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newModelDesc, setNewModelDesc] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Auto-open add form when initialAddMode is true
  useEffect(() => {
    if (isOpen && initialAddMode) {
      setIsAdding(true);
      setEditingModel(null);
      setNewModelId('');
      setNewModelLabel('');
      setNewModelDesc('');
      setValidationError(null);
    }
  }, [isOpen, initialAddMode]);

  // Reset form state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setIsAdding(false);
      setEditingModel(null);
      setNewModelId('');
      setNewModelLabel('');
      setNewModelDesc('');
      setValidationError(null);
    }
  }, [isOpen]);

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

  const validateModelId = useCallback((id: string): string | null => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      return t('settings.codexProvider.dialog.modelIdRequired') || 'Model ID is required';
    }
    if (!isValidModelId(trimmedId)) {
      return t('settings.codexProvider.dialog.modelIdInvalid') || 'Invalid model ID format';
    }
    const isDuplicate = models.some(m =>
      m.id === trimmedId && (!editingModel || m.id !== editingModel.id)
    );
    if (isDuplicate) {
      return t('settings.codexProvider.dialog.modelIdDuplicate') || 'Model ID already exists';
    }
    return null;
  }, [models, editingModel, t]);

  const handleAddModel = useCallback(() => {
    const error = validateModelId(newModelId);
    if (error) {
      setValidationError(error);
      return;
    }
    const newModel: CodexCustomModel = {
      id: newModelId.trim(),
      label: newModelLabel.trim() || newModelId.trim(),
      description: newModelDesc.trim() || undefined,
    };
    onModelsChange([...models, newModel]);
    setNewModelId('');
    setNewModelLabel('');
    setNewModelDesc('');
    setIsAdding(false);
    setValidationError(null);
  }, [models, newModelId, newModelLabel, newModelDesc, onModelsChange, validateModelId]);

  const handleSaveEdit = useCallback(() => {
    if (!editingModel) return;
    const error = validateModelId(newModelId);
    if (error) {
      setValidationError(error);
      return;
    }
    const updatedModels = models.map(m => {
      if (m.id === editingModel.id) {
        return {
          id: newModelId.trim(),
          label: newModelLabel.trim() || newModelId.trim(),
          description: newModelDesc.trim() || undefined,
        };
      }
      return m;
    });
    onModelsChange(updatedModels);
    setEditingModel(null);
    setNewModelId('');
    setNewModelLabel('');
    setNewModelDesc('');
    setIsAdding(false);
    setValidationError(null);
  }, [models, editingModel, newModelId, newModelLabel, newModelDesc, onModelsChange, validateModelId]);

  const handleEditModel = useCallback((model: CodexCustomModel) => {
    setEditingModel(model);
    setNewModelId(model.id);
    setNewModelLabel(model.label);
    setNewModelDesc(model.description || '');
    setIsAdding(true);
    setValidationError(null);
  }, []);

  const handleRemoveModel = useCallback((id: string) => {
    onModelsChange(models.filter(m => m.id !== id));
  }, [models, onModelsChange]);

  const handleCancelEdit = useCallback(() => {
    setEditingModel(null);
    setNewModelId('');
    setNewModelLabel('');
    setNewModelDesc('');
    setIsAdding(false);
    setValidationError(null);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog provider-dialog" style={{ maxWidth: '500px' }}>
        <div className="dialog-header">
          <h3>{t('settings.pluginModels.dialogTitle')}</h3>
          <button className="close-btn" onClick={onClose} title={t('common.close')}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">{t('settings.pluginModels.description')}</p>

          {/* Model list */}
          <div className={styles.modelList}>
            {models.length === 0 && !isAdding ? (
              <div className={styles.emptyState}>
                {t('settings.codexProvider.dialog.noCustomModels')}
              </div>
            ) : (
              models.map((model) => (
                <div key={model.id} className={styles.modelItem}>
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
                  </div>
                  <div className={styles.modelItemActions}>
                    <button
                      className={styles.iconBtn}
                      onClick={() => handleEditModel(model)}
                      title={t('common.edit')}
                    >
                      <span className="codicon codicon-edit" />
                    </button>
                    <button
                      className={styles.iconBtnDanger}
                      onClick={() => handleRemoveModel(model.id)}
                      title={t('common.delete')}
                    >
                      <span className="codicon codicon-trash" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Add/edit form */}
          {isAdding ? (
            <div className={styles.addEditForm}>
              <div className={styles.formRow}>
                <input
                  type="text"
                  className={`form-input ${validationError ? 'input-error' : ''}`}
                  placeholder={t('settings.codexProvider.dialog.modelIdPlaceholder')}
                  value={newModelId}
                  onChange={(e) => { setNewModelId(e.target.value); if (validationError) setValidationError(null); }}
                  style={{ flex: 1 }}
                  autoFocus
                />
                <input
                  type="text"
                  className="form-input"
                  placeholder={t('settings.codexProvider.dialog.modelLabelPlaceholder')}
                  value={newModelLabel}
                  onChange={(e) => setNewModelLabel(e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
              {validationError && (
                <div className={styles.validationError}>
                  {validationError}
                </div>
              )}
              <input
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.modelDescPlaceholder')}
                value={newModelDesc}
                onChange={(e) => setNewModelDesc(e.target.value)}
                style={{ width: '100%', marginBottom: '8px' }}
              />
              <div className={styles.formActions}>
                <button className="btn btn-secondary btn-sm" onClick={handleCancelEdit}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={editingModel ? handleSaveEdit : handleAddModel}
                  disabled={!newModelId.trim()}
                >
                  {editingModel ? t('common.save') : t('common.add')}
                </button>
              </div>
            </div>
          ) : (
            <button
              className={`btn btn-secondary btn-sm ${styles.addBtn}`}
              onClick={() => setIsAdding(true)}
            >
              <span className="codicon codicon-add" style={{ marginRight: '4px' }} />
              {t('settings.codexProvider.dialog.addModel')}
            </button>
          )}
        </div>

        <div className="dialog-footer">
          <div className={styles.dialogFooterSpacer} />
          <div className="footer-actions">
            <button className="btn btn-primary" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CustomModelDialog;
