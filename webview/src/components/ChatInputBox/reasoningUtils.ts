import { useEffect } from 'react';
import { readClaudeModelMapping } from '../../utils/claudeModelMapping';
import { MODEL_ID_TO_MAPPING_KEY } from './modelLabelUtils';
import {
  EFFORT_SUPPORTED_CLAUDE_MODELS,
  MAX_EFFORT_CLAUDE_MODELS,
  REASONING_LEVELS,
  XHIGH_EFFORT_CLAUDE_MODELS,
  codexModelSupportsMaxEffort,
  strip1MContextSuffix,
  type ReasoningEffort,
  type ReasoningInfo,
} from './types';

function resolveClaudeEffortModel(selectedModel?: string): { id: string; gateway: boolean } {
  const id = strip1MContextSuffix(selectedModel?.trim()).toLowerCase();
  const prefix = 'ccs-claude-';
  if (id.startsWith(prefix)) {
    const separator = id.indexOf('--', prefix.length);
    if (separator > prefix.length && separator + 2 < id.length) {
      // Decode only for capability checks; the request keeps the full route id.
      return { id: id.slice(separator + 2), gateway: true };
    }
  }
  return { id, gateway: false };
}

function hasConfiguredClaudeMapping(selectedModel?: string): boolean {
  const mapping = readClaudeModelMapping();
  const key = MODEL_ID_TO_MAPPING_KEY[strip1MContextSuffix(selectedModel?.trim()).toLowerCase()];
  return !!((key && mapping[key]?.trim()) || mapping.main?.trim());
}

export function claudeModelAllowsEffort(selectedModel?: string): boolean {
  const { id, gateway } = resolveClaudeEffortModel(selectedModel);
  // cc-switch routes and configured mappings are user-controlled. Forward the
  // selected effort rather than infer capabilities from a client-side alias.
  return gateway || hasConfiguredClaudeMapping(selectedModel) || EFFORT_SUPPORTED_CLAUDE_MODELS.has(id);
}

export function isReasoningVisible(currentProvider?: string, selectedModel?: string): boolean {
  return currentProvider !== 'claude' || !selectedModel || claudeModelAllowsEffort(selectedModel);
}

export function getAvailableReasoningLevels(
  currentProvider?: string,
  selectedModel?: string,
): ReasoningInfo[] {
  const { id: claudeModel, gateway } = resolveClaudeEffortModel(selectedModel);
  const configuredEffort = gateway || (currentProvider === 'claude' && hasConfiguredClaudeMapping(selectedModel));
  return REASONING_LEVELS.filter((level) => {
    if (currentProvider === 'grok') {
      return level.id === 'low' || level.id === 'medium' || level.id === 'high' || level.id === 'xhigh';
    }
    if (currentProvider === 'codex') {
      return level.id !== 'max' || (selectedModel !== undefined && codexModelSupportsMaxEffort(selectedModel));
    }
    if (currentProvider !== 'claude') {
      return level.id !== 'max';
    }
    if (configuredEffort) {
      return true;
    }
    if (!selectedModel) {
      return true;
    }
    if (level.id === 'xhigh') {
      return XHIGH_EFFORT_CLAUDE_MODELS.has(claudeModel);
    }
    if (level.id === 'max') {
      return MAX_EFFORT_CLAUDE_MODELS.has(claudeModel);
    }
    return true;
  });
}

export function resolveCurrentReasoningLevel(
  value: ReasoningEffort,
  availableLevels: ReasoningInfo[],
): ReasoningInfo | undefined {
  return availableLevels.find((level) => level.id === value)
    || availableLevels.find((level) => level.id === 'high')
    || availableLevels[availableLevels.length - 2]
    || availableLevels[0];
}

export function useReasoningEffortGuard(
  value: ReasoningEffort,
  onChange: (effort: ReasoningEffort) => void,
  selectedModel?: string,
  currentProvider?: string,
): {
  isVisible: boolean;
  availableLevels: ReasoningInfo[];
  currentLevel: ReasoningInfo | undefined;
} {
  const isVisible = isReasoningVisible(currentProvider, selectedModel);
  // Mapping changes can keep the same Sonnet/Opus alias. Re-evaluate on every
  // render so switching cc-switch modes does not retain an old filtered list.
  const availableLevels = getAvailableReasoningLevels(currentProvider, selectedModel);
  const currentLevel = resolveCurrentReasoningLevel(value, availableLevels);

  useEffect(() => {
    if (!isVisible || availableLevels.some((level) => level.id === value)) {
      return;
    }
    if (currentLevel) {
      onChange(currentLevel.id);
    }
  }, [availableLevels, currentLevel, isVisible, onChange, value]);

  return { isVisible, availableLevels, currentLevel };
}
