import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexCustomModel, ModelPricing } from '../../../types/provider';
import { sanitizeInput } from './sanitize';
import {
  EMPTY_PRICING_INPUTS,
  PRICING_FIELDS,
  buildPricing,
  formatPricingValue,
  hasPricing,
  isInvalidPricingValue,
  type PricingFieldKey,
} from './pricing';
import {
  CONTEXT_WINDOW_TOKENS_PER_K,
  isInvalidContextWindowValue,
  parseContextWindowKInput,
} from './contextWindow';

interface UseModelFormParams {
  isOpen: boolean;
  models: CodexCustomModel[];
  onModelsChange: (models: CodexCustomModel[]) => void;
  onConfiguredModelPricingChange?: (modelId: string, pricing?: ModelPricing) => void;
  contextWindowEnabled: boolean;
  initialAddMode: boolean;
}

/**
 * Owns the add/edit form state, validation, and CRUD handlers for the
 * CustomModelDialog so the dialog component stays a pure composition root.
 */
export function useModelForm({
  isOpen,
  models,
  onModelsChange,
  onConfiguredModelPricingChange,
  contextWindowEnabled,
  initialAddMode,
}: UseModelFormParams) {
  const { t } = useTranslation();

  // Form state
  const [isAdding, setIsAdding] = useState(false);
  const [editingModel, setEditingModel] = useState<CodexCustomModel | null>(null);
  const [editingConfiguredModel, setEditingConfiguredModel] = useState<CodexCustomModel | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newModelDesc, setNewModelDesc] = useState('');
  const [newContextWindowK, setNewContextWindowK] = useState('');
  const [newPricingInputs, setNewPricingInputs] = useState<Record<PricingFieldKey, string>>({ ...EMPTY_PRICING_INPUTS });
  const [modelIdError, setModelIdError] = useState<string | null>(null);
  const [contextWindowError, setContextWindowError] = useState<string | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  // Pricing is optional — collapsed by default to keep the form lightweight.
  const [pricingCollapsed, setPricingCollapsed] = useState(true);

  const resetForm = useCallback(() => {
    setIsAdding(false);
    setEditingModel(null);
    setEditingConfiguredModel(null);
    setNewModelId('');
    setNewModelLabel('');
    setNewModelDesc('');
    setNewContextWindowK('');
    setNewPricingInputs({ ...EMPTY_PRICING_INPUTS });
    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
    setPricingCollapsed(true);
  }, []);

  // Auto-open add form when initialAddMode is true
  useEffect(() => {
    if (isOpen && initialAddMode) {
      resetForm();
      setIsAdding(true);
    }
  }, [isOpen, initialAddMode, resetForm]);

  // Reset form state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  // A pricing validation error only surfaces on submit — make sure the
  // collapsed section expands so the user can see what went wrong.
  useEffect(() => {
    if (pricingError) {
      setPricingCollapsed(false);
    }
  }, [pricingError]);

  const validateModelId = useCallback((id: string): string | null => {
    const trimmedId = sanitizeInput(id).trim();
    if (!trimmedId || trimmedId.length > 256) {
      return t('settings.codexProvider.dialog.modelIdRequired') || 'Model ID is required';
    }
    const isDuplicate = models.some(m =>
      m.id === trimmedId && (!editingModel || m.id !== editingModel.id)
    );
    if (isDuplicate) {
      return t('settings.codexProvider.dialog.modelIdDuplicate') || 'Model ID already exists';
    }
    return null;
  }, [models, editingModel, t]);

  const validatePricingInputs = useCallback((): string | null => {
    const hasInvalidPrice = PRICING_FIELDS.some(({ key }) => isInvalidPricingValue(newPricingInputs[key]));
    if (!hasInvalidPrice) {
      return null;
    }
    return t('settings.pluginModels.pricing.invalidValue', {
      defaultValue: 'Pricing must be a non-negative number',
    });
  }, [newPricingInputs, t]);

  const validateContextWindowInput = useCallback((): string | null => {
    if (!isInvalidContextWindowValue(newContextWindowK)) {
      return null;
    }
    return t('settings.pluginModels.contextWindow.invalidValue', {
      defaultValue: 'Maximum context must be a positive integer in K units',
    });
  }, [newContextWindowK, t]);

  const buildModelFromForm = useCallback((): CodexCustomModel => {
    const sanitizedId = sanitizeInput(newModelId).trim();
    const sanitizedLabel = sanitizeInput(newModelLabel).trim();
    const sanitizedDescription = sanitizeInput(newModelDesc).trim();
    const contextWindowTokens = parseContextWindowKInput(newContextWindowK);
    const pricing = buildPricing(newPricingInputs);
    const model: CodexCustomModel = {
      id: sanitizedId,
      label: sanitizedLabel || sanitizedId,
      description: sanitizedDescription || undefined,
    };

    if (contextWindowEnabled && contextWindowTokens !== undefined) {
      model.contextWindowTokens = contextWindowTokens;
    }

    return pricing ? { ...model, pricing } : model;
  }, [contextWindowEnabled, newModelId, newModelLabel, newModelDesc, newContextWindowK, newPricingInputs]);

  const validateForm = useCallback((): boolean => {
    if (editingConfiguredModel) {
      const priceError = validatePricingInputs();
      if (priceError) {
        setModelIdError(null);
        setContextWindowError(null);
        setPricingError(priceError);
        return false;
      }
      setModelIdError(null);
      setContextWindowError(null);
      setPricingError(null);
      return true;
    }

    const idError = validateModelId(newModelId);
    if (idError) {
      setModelIdError(idError);
      setContextWindowError(null);
      setPricingError(null);
      return false;
    }

    const contextError = contextWindowEnabled ? validateContextWindowInput() : null;
    if (contextError) {
      setModelIdError(null);
      setContextWindowError(contextError);
      setPricingError(null);
      return false;
    }

    const priceError = validatePricingInputs();
    if (priceError) {
      setModelIdError(null);
      setContextWindowError(null);
      setPricingError(priceError);
      return false;
    }

    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
    return true;
  }, [contextWindowEnabled, editingConfiguredModel, newModelId, validateContextWindowInput, validateModelId, validatePricingInputs]);

  const handleAddModel = useCallback(() => {
    if (!validateForm()) {
      return;
    }

    onModelsChange([...models, buildModelFromForm()]);
    resetForm();
  }, [models, onModelsChange, buildModelFromForm, resetForm, validateForm]);

  const handleSaveEdit = useCallback(() => {
    if (!editingModel || !validateForm()) return;

    const updatedModel = buildModelFromForm();
    const updatedModels = models.map(m => (m.id === editingModel.id ? updatedModel : m));
    onModelsChange(updatedModels);
    resetForm();
  }, [models, editingModel, onModelsChange, buildModelFromForm, resetForm, validateForm]);

  const handleSaveConfiguredPricing = useCallback(() => {
    if (!editingConfiguredModel || !validateForm()) return;

    onConfiguredModelPricingChange?.(editingConfiguredModel.id, buildPricing(newPricingInputs));
    resetForm();
  }, [editingConfiguredModel, newPricingInputs, onConfiguredModelPricingChange, resetForm, validateForm]);

  const handleEditModel = useCallback((model: CodexCustomModel) => {
    setEditingConfiguredModel(null);
    setEditingModel(model);
    setNewModelId(model.id);
    setNewModelLabel(model.label);
    setNewModelDesc(model.description || '');
    setNewContextWindowK(!contextWindowEnabled || model.contextWindowTokens === undefined
      ? ''
      : String(model.contextWindowTokens / CONTEXT_WINDOW_TOKENS_PER_K));
    setNewPricingInputs({
      inputCostPer1M: formatPricingValue(model.pricing?.inputCostPer1M),
      outputCostPer1M: formatPricingValue(model.pricing?.outputCostPer1M),
      cacheWriteCostPer1M: formatPricingValue(model.pricing?.cacheWriteCostPer1M),
      cacheReadCostPer1M: formatPricingValue(model.pricing?.cacheReadCostPer1M),
    });
    // Reveal pricing only when the model already has rates to edit.
    setPricingCollapsed(!hasPricing(model.pricing));
    setIsAdding(true);
    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
  }, [contextWindowEnabled]);

  const handleEditConfiguredModelPricing = useCallback((model: CodexCustomModel) => {
    setEditingModel(null);
    setEditingConfiguredModel(model);
    setNewModelId(model.id);
    setNewModelLabel(model.label || model.id);
    setNewModelDesc(model.description || '');
    setNewContextWindowK('');
    setNewPricingInputs({
      inputCostPer1M: formatPricingValue(model.pricing?.inputCostPer1M),
      outputCostPer1M: formatPricingValue(model.pricing?.outputCostPer1M),
      cacheWriteCostPer1M: formatPricingValue(model.pricing?.cacheWriteCostPer1M),
      cacheReadCostPer1M: formatPricingValue(model.pricing?.cacheReadCostPer1M),
    });
    // For provider-configured models pricing is the only editable field.
    setPricingCollapsed(false);
    setIsAdding(true);
    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    resetForm();
  }, [resetForm]);

  const handleModelIdChange = useCallback((value: string) => {
    setNewModelId(value);
    if (modelIdError) setModelIdError(null);
  }, [modelIdError]);

  const handleContextWindowKChange = useCallback((value: string) => {
    setNewContextWindowK(value);
    if (contextWindowError) setContextWindowError(null);
  }, [contextWindowError]);

  const handlePricingInputChange = useCallback((key: PricingFieldKey, value: string) => {
    setNewPricingInputs(prev => ({ ...prev, [key]: value }));
    if (pricingError) setPricingError(null);
  }, [pricingError]);

  const handleTogglePricingCollapsed = useCallback(() => {
    setPricingCollapsed(prev => !prev);
  }, []);

  const startAdd = useCallback(() => {
    setIsAdding(true);
  }, []);

  const isEditingConfiguredModel = !!editingConfiguredModel;
  const isEditingAnyModel = !!editingModel || isEditingConfiguredModel;
  const handleSubmitForm = isEditingConfiguredModel
    ? handleSaveConfiguredPricing
    : editingModel
      ? handleSaveEdit
      : handleAddModel;

  return {
    isAdding,
    startAdd,
    isEditingConfiguredModel,
    isEditingAnyModel,
    newModelId,
    newModelLabel,
    newModelDesc,
    newContextWindowK,
    newPricingInputs,
    modelIdError,
    contextWindowError,
    pricingError,
    pricingCollapsed,
    setNewModelLabel,
    setNewModelDesc,
    handleModelIdChange,
    handleContextWindowKChange,
    handlePricingInputChange,
    handleTogglePricingCollapsed,
    handleEditModel,
    handleEditConfiguredModelPricing,
    handleCancelEdit,
    handleSubmitForm,
  };
}
