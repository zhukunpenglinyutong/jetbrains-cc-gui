import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { useReasoningEffortGuard } from '../reasoningUtils';
import {
  AVAILABLE_MODELS,
  type CodexFastMode,
  type ModelInfo,
  type ReasoningEffort,
} from '../types';
import { ModelConfigDropdown } from './ModelConfigDropdown';
import { ModelConfigTrigger } from './ModelConfigTrigger';
import { useModelConfigSubmenu } from './useModelConfigSubmenu';
import { useCurrentModel, useModelConfigRows, useModelConfigSummary } from './useModelConfigSummary';

export {
  SUBMENU_HOVER_DELAY_MS,
  SUBMENU_TRIGGER_DELAY_MS,
} from './useModelConfigSubmenu';

const WRAPPER_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };

interface ModelConfigSelectProps {
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (effort: ReasoningEffort) => void;
  codexFastMode?: CodexFastMode;
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  dshPreset?: string;
  onDshPresetChange?: (preset: string) => void;
}

/**
 * Model-settings selector: one summary trigger whose popover keeps the model
 * list flat at the top; the function rows (1M context / Codex speed / DSH
 * preset / effort) sit below it, next to the trigger. Rows that offer a
 * choice open fly-out submenus beside them.
 */
export const ModelConfigSelect = ({
  selectedModel,
  onModelSelect,
  models = AVAILABLE_MODELS,
  currentProvider = 'claude',
  loading = false,
  error = null,
  onRetry,
  onAddModel,
  longContextEnabled = true,
  onLongContextChange,
  reasoningEffort = 'high',
  onReasoningChange,
  codexFastMode = 'normal',
  onCodexFastModeChange,
  dshPreset = '',
  onDshPresetChange,
}: ModelConfigSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const {
    activeSubmenu,
    effortTriggerRef,
    speedTriggerRef,
    presetTriggerRef,
    openSubmenu,
    scheduleSubmenu,
    retainActiveSubmenu,
    resetSubmenu,
  } = useModelConfigSubmenu();

  const { positionedStyle: mainPositionedStyle, maxHeight: mainMaxHeight, recalculate: mainRecalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
    minWidth: 220,
  });

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    onReasoningChange?.(effort);
  }, [onReasoningChange]);

  const { isVisible: showEffort, currentLevel } = useReasoningEffortGuard(
    reasoningEffort,
    handleReasoningChange,
    selectedModel,
    currentProvider,
  );

  const modelMapping = readClaudeModelMapping();
  const currentModel = useCurrentModel(models, selectedModel, currentProvider);
  const {
    show1MContext,
    showContextRow,
    showEffortRow,
    showSpeed,
    showPreset,
    contextSupported,
    showDivider,
  } = useModelConfigRows({
    selectedModel,
    currentProvider,
    longContextEnabled,
    onLongContextChange,
    onReasoningChange,
    onCodexFastModeChange,
    onDshPresetChange,
    showEffort,
  });
  const {
    speedLabel,
    dshPresetLabel,
    effortLabel,
    summaryText,
  } = useModelConfigSummary({
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
  });

  const closeMenu = useCallback(() => {
    resetSubmenu();
    setIsOpen(false);
  }, [resetSubmenu]);

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    resetSubmenu();
    if (nextOpen) {
      mainRecalculate();
    }
  }, [resetSubmenu, isOpen, mainRecalculate]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current
        && !dropdownRef.current.contains(event.target as Node)
        && buttonRef.current
        && !buttonRef.current.contains(event.target as Node)
      ) {
        closeMenu();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [closeMenu, isOpen]);

  useLayoutEffect(() => {
    if (isOpen) {
      mainRecalculate();
    }
  }, [isOpen, mainRecalculate, showEffortRow, showSpeed, showPreset, showContextRow]);

  return (
    <div style={WRAPPER_STYLE}>
      <ModelConfigTrigger
        buttonRef={buttonRef}
        isOpen={isOpen}
        summaryText={summaryText}
        currentModel={currentModel}
        currentProvider={currentProvider}
        modelMapping={modelMapping}
        onToggle={handleToggle}
      />

      {isOpen && (
        <ModelConfigDropdown
          dropdownRef={dropdownRef}
          positionedStyle={mainPositionedStyle}
          maxHeight={mainMaxHeight}
          onMouseOverCapture={retainActiveSubmenu}
          onClose={closeMenu}
          selectedModel={selectedModel}
          onModelSelect={onModelSelect}
          models={models}
          currentProvider={currentProvider}
          loading={loading}
          error={error}
          onRetry={onRetry}
          onAddModel={onAddModel}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
          showDivider={showDivider}
          showContextRow={showContextRow}
          contextSupported={contextSupported}
          showSpeed={showSpeed}
          codexFastMode={codexFastMode}
          onCodexFastModeChange={onCodexFastModeChange}
          speedLabel={speedLabel}
          showPreset={showPreset}
          dshPreset={dshPreset}
          onDshPresetChange={onDshPresetChange}
          dshPresetLabel={dshPresetLabel}
          showEffortRow={showEffortRow}
          reasoningEffort={reasoningEffort}
          onReasoningChange={handleReasoningChange}
          effortLabel={effortLabel}
          activeSubmenu={activeSubmenu}
          effortTriggerRef={effortTriggerRef}
          speedTriggerRef={speedTriggerRef}
          presetTriggerRef={presetTriggerRef}
          scheduleSubmenu={scheduleSubmenu}
          openSubmenu={openSubmenu}
        />
      )}
    </div>
  );
};

export default ModelConfigSelect;
