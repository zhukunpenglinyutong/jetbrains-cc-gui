import { useState, useCallback } from 'react';
import type { CodexCustomModel } from '../../../types/provider';
import { isValidModelId } from '../../../types/provider';

export interface CustomModelEditorProps {
  models: CodexCustomModel[];
  onModelsChange: (models: CodexCustomModel[]) => void;
  t: (key: string) => string;
}

/**
 * 自定义模型编辑器组件
 * 用于管理 Codex 供应商的自定义模型列表
 */
export function CustomModelEditor({
  models,
  onModelsChange,
  t,
}: CustomModelEditorProps) {
  const [editingModel, setEditingModel] = useState<CodexCustomModel | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newModelDesc, setNewModelDesc] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  /**
   * 验证模型 ID 并返回错误消息
   */
  const validateModelId = useCallback((id: string): string | null => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      return t('settings.codexProvider.dialog.modelIdRequired') || 'Model ID is required';
    }
    if (!isValidModelId(trimmedId)) {
      return t('settings.codexProvider.dialog.modelIdInvalid') || 'Invalid model ID format';
    }
    // 检查重复（编辑时排除当前模型）
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

  const handleRemoveModel = useCallback((id: string) => {
    onModelsChange(models.filter(m => m.id !== id));
  }, [models, onModelsChange]);

  const handleEditModel = useCallback((model: CodexCustomModel) => {
    setEditingModel(model);
    setNewModelId(model.id);
    setNewModelLabel(model.label);
    setNewModelDesc(model.description || '');
    setIsAdding(true);
    setValidationError(null);
  }, []);

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

  const handleCancelEdit = useCallback(() => {
    setEditingModel(null);
    setNewModelId('');
    setNewModelLabel('');
    setNewModelDesc('');
    setIsAdding(false);
    setValidationError(null);
  }, []);

  const handleModelIdChange = useCallback((value: string) => {
    setNewModelId(value);
    // 清除之前的验证错误
    if (validationError) {
      setValidationError(null);
    }
  }, [validationError]);

  return (
    <div className="custom-models-editor" role="region" aria-label={t('settings.codexProvider.dialog.customModels')}>
      {/* 模型列表 */}
      <div className="models-list" role="list" aria-label={t('settings.codexProvider.dialog.customModels')}>
        {models.length === 0 ? (
          <div className="empty-models" role="status">{t('settings.codexProvider.dialog.noCustomModels')}</div>
        ) : (
          models.map((model) => (
            <div key={model.id} className="model-item" role="listitem">
              <div className="model-info">
                <span className="model-id">{model.id}</span>
                {model.label !== model.id && (
                  <span className="model-label">({model.label})</span>
                )}
                {model.description && (
                  <span className="model-desc">{model.description}</span>
                )}
              </div>
              <div className="model-actions">
                <button
                  type="button"
                  className="btn btn-icon"
                  onClick={() => handleEditModel(model)}
                  title={t('common.edit')}
                  aria-label={`${t('common.edit')} ${model.id}`}
                >
                  <span className="codicon codicon-edit" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-danger"
                  onClick={() => handleRemoveModel(model.id)}
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

      {/* 添加/编辑模型表单 */}
      {isAdding ? (
        <div className="add-model-form" role="form" aria-label={editingModel ? t('common.edit') : t('common.add')}>
          <div className="form-row">
            <div className="form-field">
              <label htmlFor="model-id-input" className="sr-only">
                {t('settings.codexProvider.dialog.modelIdPlaceholder')}
              </label>
              <input
                id="model-id-input"
                type="text"
                className={`form-input ${validationError ? 'input-error' : ''}`}
                placeholder={t('settings.codexProvider.dialog.modelIdPlaceholder')}
                value={newModelId}
                onChange={(e) => handleModelIdChange(e.target.value)}
                aria-invalid={!!validationError}
                aria-describedby={validationError ? 'model-id-error' : undefined}
              />
            </div>
            <div className="form-field">
              <label htmlFor="model-label-input" className="sr-only">
                {t('settings.codexProvider.dialog.modelLabelPlaceholder')}
              </label>
              <input
                id="model-label-input"
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.modelLabelPlaceholder')}
                value={newModelLabel}
                onChange={(e) => setNewModelLabel(e.target.value)}
              />
            </div>
          </div>
          {validationError && (
            <div id="model-id-error" className="form-error" role="alert">
              {validationError}
            </div>
          )}
          <div className="form-row">
            <div className="form-field form-field-full">
              <label htmlFor="model-desc-input" className="sr-only">
                {t('settings.codexProvider.dialog.modelDescPlaceholder')}
              </label>
              <input
                id="model-desc-input"
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.modelDescPlaceholder')}
                value={newModelDesc}
                onChange={(e) => setNewModelDesc(e.target.value)}
              />
            </div>
          </div>
          <div className="form-row form-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleCancelEdit}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
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
          type="button"
          className="btn btn-secondary btn-sm add-model-btn"
          onClick={() => setIsAdding(true)}
          aria-label={t('settings.codexProvider.dialog.addModel')}
        >
          <span className="codicon codicon-add" aria-hidden="true" />
          {t('settings.codexProvider.dialog.addModel')}
        </button>
      )}
    </div>
  );
}

export default CustomModelEditor;
