import type { TFunction } from 'i18next';
import type { DropdownItemData, DropdownPosition, PermissionMode, ReasoningEffort, SelectedAgent } from './types.js';
import type { TooltipState } from './hooks/useTooltip.js';
import { ButtonArea } from './ButtonArea.js';
import { CompletionDropdown } from './Dropdown/index.js';
import { PromptEnhancerDialog } from './PromptEnhancerDialog.js';

interface CompletionController {
  isOpen: boolean;
  position: DropdownPosition | null;
  items: DropdownItemData[];
  activeIndex: number;
  loading: boolean;
  close: () => void;
  selectIndex: (index: number) => void;
  handleMouseEnter: (index: number) => void;
}

export function ChatInputBoxFooter({
  disabled,
  hasInputContent,
  isLoading,
  isEnhancing,
  selectedModel,
  permissionMode,
  currentProvider,
  reasoningEffort,
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  onReasoningChange,
  onEnhancePrompt,
  alwaysThinkingEnabled,
  onToggleThinking,
  streamingEnabled,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
  onClearAgent,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  tooltip,
  promptEnhancer,
  t,
}: {
  disabled: boolean;
  hasInputContent: boolean;
  isLoading: boolean;
  isEnhancing: boolean;
  selectedModel: string;
  permissionMode: PermissionMode;
  currentProvider: string;
  reasoningEffort: ReasoningEffort;
  onSubmit: () => void;
  onStop?: () => void;
  onModeSelect?: (mode: PermissionMode) => void;
  onModelSelect?: (modelId: string) => void;
  onProviderSelect?: (providerId: string) => void;
  onReasoningChange?: (effort: ReasoningEffort) => void;
  onEnhancePrompt: () => void;
  alwaysThinkingEnabled?: boolean;
  onToggleThinking?: (enabled: boolean) => void;
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  selectedAgent?: SelectedAgent | null;
  onAgentSelect?: (agent: SelectedAgent) => void;
  onOpenAgentSettings?: () => void;
  onClearAgent: () => void;
  fileCompletion: CompletionController;
  commandCompletion: CompletionController;
  agentCompletion: CompletionController;
  tooltip: TooltipState | null;
  promptEnhancer: {
    isOpen: boolean;
    isLoading: boolean;
    originalPrompt: string;
    enhancedPrompt: string;
    onUseEnhanced: () => void;
    onKeepOriginal: () => void;
    onClose: () => void;
  };
  t: TFunction;
}) {
  return (
    <>
      {/* Bottom button area */}
      <ButtonArea
        disabled={disabled || isLoading}
        hasInputContent={hasInputContent}
        isLoading={isLoading}
        isEnhancing={isEnhancing}
        selectedModel={selectedModel}
        permissionMode={permissionMode}
        currentProvider={currentProvider}
        reasoningEffort={reasoningEffort}
        onSubmit={onSubmit}
        onStop={onStop}
        onModeSelect={onModeSelect}
        onModelSelect={onModelSelect}
        onProviderSelect={onProviderSelect}
        onReasoningChange={onReasoningChange}
        onEnhancePrompt={onEnhancePrompt}
        alwaysThinkingEnabled={alwaysThinkingEnabled}
        onToggleThinking={onToggleThinking}
        streamingEnabled={streamingEnabled}
        onStreamingEnabledChange={onStreamingEnabledChange}
        selectedAgent={selectedAgent}
        onAgentSelect={(agent) => onAgentSelect?.(agent)}
        onOpenAgentSettings={onOpenAgentSettings}
        onClearAgent={onClearAgent}
      />

      {/* @ file reference dropdown menu */}
      <CompletionDropdown
        isVisible={fileCompletion.isOpen}
        position={fileCompletion.position}
        items={fileCompletion.items}
        selectedIndex={fileCompletion.activeIndex}
        loading={fileCompletion.loading}
        emptyText={t('chat.noMatchingFiles')}
        onClose={fileCompletion.close}
        onSelect={(_, index) => fileCompletion.selectIndex(index)}
        onMouseEnter={fileCompletion.handleMouseEnter}
      />

      {/* / slash command dropdown menu */}
      <CompletionDropdown
        isVisible={commandCompletion.isOpen}
        position={commandCompletion.position}
        width={450}
        items={commandCompletion.items}
        selectedIndex={commandCompletion.activeIndex}
        loading={commandCompletion.loading}
        emptyText={t('chat.noMatchingCommands')}
        onClose={commandCompletion.close}
        onSelect={(_, index) => commandCompletion.selectIndex(index)}
        onMouseEnter={commandCompletion.handleMouseEnter}
      />

      {/* # agent selection dropdown menu */}
      <CompletionDropdown
        isVisible={agentCompletion.isOpen}
        position={agentCompletion.position}
        width={350}
        items={agentCompletion.items}
        selectedIndex={agentCompletion.activeIndex}
        loading={agentCompletion.loading}
        emptyText={t('chat.noAvailableAgents')}
        onClose={agentCompletion.close}
        onSelect={(_, index) => agentCompletion.selectIndex(index)}
        onMouseEnter={agentCompletion.handleMouseEnter}
      />

      {/* Floating Tooltip (uses Portal or Fixed positioning to break overflow limit) */}
      {tooltip && tooltip.visible && (
        <div
          className={`tooltip-popup ${tooltip.isBar ? 'tooltip-bar' : ''}`}
          style={{
            top: `${tooltip.top}px`,
            left: `${tooltip.left}px`,
            width: tooltip.width ? `${tooltip.width}px` : undefined,
            // @ts-expect-error CSS custom properties
            '--tooltip-tx': tooltip.tx || '-50%',
            '--arrow-left': tooltip.arrowLeft || '50%',
          }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Prompt enhancer dialog */}
      <PromptEnhancerDialog
        isOpen={promptEnhancer.isOpen}
        isLoading={promptEnhancer.isLoading}
        originalPrompt={promptEnhancer.originalPrompt}
        enhancedPrompt={promptEnhancer.enhancedPrompt}
        onUseEnhanced={promptEnhancer.onUseEnhanced}
        onKeepOriginal={promptEnhancer.onKeepOriginal}
        onClose={promptEnhancer.onClose}
      />
    </>
  );
}

