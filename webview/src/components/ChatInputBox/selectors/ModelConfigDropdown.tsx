import { useTranslation } from 'react-i18next';
import type { CodexFastMode, ModelInfo, ReasoningEffort } from '../types';
import { CodexFastModeSelect } from './CodexFastModeSelect';
import { DshPresetSelect } from './DshPresetSelect';
import { ModelConfigContextRow } from './ModelConfigContextRow';
import { ModelConfigSubmenuRow } from './ModelConfigSubmenuRow';
import { ModelSelect } from './ModelSelect';
import { ReasoningSelect } from './ReasoningSelect';
import type { ActiveSubmenu } from './useModelConfigSubmenu';

const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  minWidth: '220px',
  maxWidth: 'calc(100vw - 16px)',
  overflow: 'visible',
};

interface ModelConfigDropdownProps {
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  positionedStyle: React.CSSProperties;
  maxHeight: number | undefined;
  onMouseOverCapture: (event: React.MouseEvent) => void;
  onClose: () => void;
  // Flat model list at the top of the popover.
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  models: ModelInfo[];
  currentProvider: string;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  onAddModel?: () => void;
  longContextEnabled: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  // Function rows below the model list.
  showDivider: boolean;
  showContextRow: boolean;
  contextSupported: boolean;
  showSpeed: boolean;
  codexFastMode: CodexFastMode;
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  speedLabel: string;
  showPreset: boolean;
  dshPreset: string;
  onDshPresetChange?: (preset: string) => void;
  dshPresetLabel: string;
  showEffortRow: boolean;
  reasoningEffort: ReasoningEffort;
  onReasoningChange: (effort: ReasoningEffort) => void;
  effortLabel: string;
  // Fly-out submenu state.
  activeSubmenu: ActiveSubmenu;
  effortTriggerRef: React.RefObject<HTMLDivElement | null>;
  speedTriggerRef: React.RefObject<HTMLDivElement | null>;
  presetTriggerRef: React.RefObject<HTMLDivElement | null>;
  scheduleSubmenu: (submenu: ActiveSubmenu) => void;
  openSubmenu: (submenu: ActiveSubmenu) => void;
}

/**
 * The model-settings popover: the flat model list on top, then the function
 * rows (1M context / Codex speed / DSH preset / effort) whose choices open
 * fly-out submenus beside them.
 */
export const ModelConfigDropdown = ({
  dropdownRef,
  positionedStyle,
  maxHeight,
  onMouseOverCapture,
  onClose,
  selectedModel,
  onModelSelect,
  models,
  currentProvider,
  loading,
  error,
  onRetry,
  onAddModel,
  longContextEnabled,
  onLongContextChange,
  showDivider,
  showContextRow,
  contextSupported,
  showSpeed,
  codexFastMode,
  onCodexFastModeChange,
  speedLabel,
  showPreset,
  dshPreset,
  onDshPresetChange,
  dshPresetLabel,
  showEffortRow,
  reasoningEffort,
  onReasoningChange,
  effortLabel,
  activeSubmenu,
  effortTriggerRef,
  speedTriggerRef,
  presetTriggerRef,
  scheduleSubmenu,
  openSubmenu,
}: ModelConfigDropdownProps) => {
  const { t } = useTranslation();
  return (
    <div
      ref={dropdownRef}
      className="selector-dropdown model-config-dropdown"
      data-testid="model-config-dropdown"
      style={{ ...DROPDOWN_STYLE, ...positionedStyle, maxHeight, boxSizing: 'border-box' }}
      onMouseOverCapture={onMouseOverCapture}
    >
      {/* The flat list has no hover row of its own; entering it must
          dismiss any open fly-out (effort / speed / preset). It sits at
          the top so model switching — the most frequent action — never
          crosses the submenu rows. */}
      <div className="model-config-models" onMouseEnter={() => scheduleSubmenu('none')}>
        <ModelSelect
          value={selectedModel}
          onChange={onModelSelect}
          models={models}
          currentProvider={currentProvider}
          loading={loading}
          error={error}
          onRetry={onRetry}
          onAddModel={onAddModel}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
          inline
          hideLongContextToggle
          onClose={onClose}
        />
      </div>

      {showDivider && <div className="selector-divider" />}

      <ModelConfigContextRow
        visible={showContextRow}
        supported={contextSupported}
        enabled={longContextEnabled}
        onChange={onLongContextChange}
        onHover={() => scheduleSubmenu('none')}
      />

      <ModelConfigSubmenuRow
        visible={showSpeed && !!onCodexFastModeChange}
        active={activeSubmenu === 'speed'}
        testId="model-config-option-speed"
        label={t('modelConfig.speed', { defaultValue: 'Speed' })}
        valueLabel={speedLabel}
        triggerRef={speedTriggerRef}
        onHover={() => scheduleSubmenu('speed')}
        onOpen={() => openSubmenu('speed')}
      >
        {onCodexFastModeChange && (
          <CodexFastModeSelect
            value={codexFastMode}
            onChange={onCodexFastModeChange}
            embedded
            triggerRef={speedTriggerRef}
            onClose={onClose}
          />
        )}
      </ModelConfigSubmenuRow>

      <ModelConfigSubmenuRow
        visible={showPreset && !!onDshPresetChange}
        active={activeSubmenu === 'preset'}
        testId="model-config-option-preset"
        label={t('modelConfig.preset', { defaultValue: 'Preset' })}
        valueLabel={dshPresetLabel}
        triggerRef={presetTriggerRef}
        onHover={() => scheduleSubmenu('preset')}
        onOpen={() => openSubmenu('preset')}
      >
        {onDshPresetChange && (
          <DshPresetSelect
            value={dshPreset}
            onChange={onDshPresetChange}
            embedded
            triggerRef={presetTriggerRef}
            onClose={onClose}
          />
        )}
      </ModelConfigSubmenuRow>

      <ModelConfigSubmenuRow
        visible={showEffortRow}
        active={activeSubmenu === 'effort'}
        testId="model-config-option-effort"
        label={t('modelConfig.effort', { defaultValue: 'Effort' })}
        valueLabel={effortLabel}
        triggerRef={effortTriggerRef}
        onHover={() => scheduleSubmenu('effort')}
        onOpen={() => openSubmenu('effort')}
      >
        <ReasoningSelect
          value={reasoningEffort}
          onChange={onReasoningChange}
          selectedModel={selectedModel}
          currentProvider={currentProvider}
          embedded
          triggerRef={effortTriggerRef}
          onClose={onClose}
        />
      </ModelConfigSubmenuRow>
    </div>
  );
};
