import { useMemo } from 'react';
import type { ClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { resolveModelDisplayLabel } from '../modelLabelUtils';
import {
  DSH_PRESETS,
  REASONING_LEVELS,
  getUserDshPresetOptions,
  modelSupports1MContext,
  normalizeClaudeModelId,
  strip1MContextSuffix,
  type CodexFastMode,
  type ModelInfo,
  type ReasoningEffort,
  type ReasoningInfo,
} from '../types';

function getReasoningLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
  effort: ReasoningEffort,
): string {
  const fallback = REASONING_LEVELS.find((level) => level.id === effort)?.label || effort;
  return t(`reasoning.${effort}.label`, { defaultValue: fallback });
}

/**
 * Resolve the display model for the trigger icon: exact id after stripping
 * the 1M suffix, Claude-alias normalization, then a bare fallback entry.
 */
export const useCurrentModel = (
  models: ModelInfo[],
  selectedModel: string,
  currentProvider: string,
) => {
  const strippedValue = strip1MContextSuffix(selectedModel);
  const normalizedValue = currentProvider === 'claude' ? normalizeClaudeModelId(strippedValue) : strippedValue;
  return models.find((model) => model.id === normalizedValue)
    || models.find((model) => model.id === strippedValue)
    || (strippedValue
      ? { id: strippedValue, label: strippedValue } as ModelInfo
      : models[0]);
};

interface UseModelConfigRowsInput {
  selectedModel: string;
  currentProvider: string;
  longContextEnabled: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  onReasoningChange?: (effort: ReasoningEffort) => void;
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  onDshPresetChange?: (preset: string) => void;
  showEffort: boolean;
}

/**
 * Which function rows the popover shows for the current provider, plus the
 * divider between the flat model list and those rows.
 */
export const useModelConfigRows = ({
  selectedModel,
  currentProvider,
  longContextEnabled,
  onLongContextChange,
  onReasoningChange,
  onCodexFastModeChange,
  onDshPresetChange,
  showEffort,
}: UseModelConfigRowsInput) => {
  const show1MContext = currentProvider === 'claude'
    && modelSupports1MContext(selectedModel)
    && longContextEnabled;
  const showContextRow = currentProvider === 'claude' && !!onLongContextChange;
  const showEffortRow = showEffort && !!onReasoningChange;
  const showSpeed = currentProvider === 'codex' && !!onCodexFastModeChange;
  const showPreset = currentProvider === 'dsh' && !!onDshPresetChange;
  const contextSupported = modelSupports1MContext(selectedModel);
  const hasTrailingRows = showContextRow || showSpeed || showPreset;
  const showDivider = showEffortRow || hasTrailingRows;

  return {
    show1MContext,
    showContextRow,
    showEffortRow,
    showSpeed,
    showPreset,
    contextSupported,
    showDivider,
  };
};

interface UseModelConfigSummaryInput {
  t: (key: string, options?: { defaultValue?: string }) => string;
  selectedModel: string;
  currentModel: ModelInfo | undefined;
  currentProvider: string;
  modelMapping: ClaudeModelMapping;
  longContextEnabled: boolean;
  codexFastMode: CodexFastMode;
  dshPreset: string;
  show1MContext: boolean;
  showEffortRow: boolean;
  showSpeed: boolean;
  showPreset: boolean;
  currentLevel: ReasoningInfo | undefined;
}

/**
 * The current-value label of each function row and the combined summary
 * text shown on the trigger (model + 1M + effort + speed + preset).
 */
export const useModelConfigSummary = ({
  t,
  selectedModel,
  currentModel,
  currentProvider,
  modelMapping,
  longContextEnabled,
  codexFastMode,
  dshPreset,
  show1MContext,
  showEffortRow,
  showSpeed,
  showPreset,
  currentLevel,
}: UseModelConfigSummaryInput) => {
  const modelLabel = currentModel
    ? resolveModelDisplayLabel(currentModel, {
        t,
        currentProvider,
        modelMapping: currentProvider === 'claude' ? modelMapping : {},
        show1MContext: false,
        longContextEnabled,
      })
    : selectedModel;

  const dshOptions = useMemo(
    () => [...DSH_PRESETS, ...getUserDshPresetOptions()],
    [],
  );
  const currentDshPreset = dshOptions.find((preset) => preset.id === dshPreset) || dshOptions[0];
  const dshPresetLabel = currentDshPreset?.label
    || (currentDshPreset?.labelKey ? t(currentDshPreset.labelKey, { defaultValue: currentDshPreset.id }) : '');
  const effortLabel = currentLevel ? getReasoningLabel(t, currentLevel.id) : '';
  const speedLabel = t(`codexFastMode.${codexFastMode}.label`, {
    defaultValue: codexFastMode === 'fast' ? 'Fast' : 'Standard',
  });
  const summaryParts = [
    modelLabel,
    show1MContext ? t('models.longContext.label', { defaultValue: '1M' }) : '',
    showEffortRow ? effortLabel : '',
    showSpeed && codexFastMode === 'fast' ? speedLabel : '',
    showPreset && dshPreset ? dshPresetLabel : '',
  ].filter(Boolean);
  const summaryText = summaryParts.join(' ');

  return {
    speedLabel,
    dshPresetLabel,
    effortLabel,
    summaryText,
  };
};
