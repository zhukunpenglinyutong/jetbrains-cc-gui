import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useClaudePlanUsage } from '../../hooks/useClaudePlanUsage';
import { PlanUsageIndicator } from './PlanUsageIndicator';

interface ContextToolsRightProps {
  currentProvider: string;
  hasMessages: boolean;
  onRewind?: () => void;
  statusPanelExpanded: boolean;
  onToggleStatusPanel?: () => void;
}

/** Right side tools: plan usage, StatusPanel toggle and Rewind button. */
export const ContextToolsRight: React.FC<ContextToolsRightProps> = memo(({
  currentProvider,
  hasMessages,
  onRewind,
  statusPanelExpanded,
  onToggleStatusPanel,
}) => {
  const { t } = useTranslation();
  const isClaude = currentProvider === 'claude';
  const claudePlanUsage = useClaudePlanUsage(currentProvider);

  return (
    <div className="context-tools-right">
      {isClaude && (
        <PlanUsageIndicator
          snapshot={claudePlanUsage.snapshot}
          status={claudePlanUsage.status}
        />
      )}

      {/* StatusPanel expand/collapse toggle - always visible */}
      {onToggleStatusPanel && (
        <button
          className={`context-tool-btn status-panel-toggle has-tooltip ${statusPanelExpanded ? 'expanded' : 'collapsed'}`}
          onClick={onToggleStatusPanel}
          data-tooltip={statusPanelExpanded ? t('statusPanel.collapse') : t('statusPanel.expand')}
        >
          <span className={`codicon ${statusPanelExpanded ? 'codicon-chevron-down' : 'codicon-layers'}`} />
        </button>
      )}

      {/* Rewind button */}
      {currentProvider === 'claude' && onRewind && (
        <button
          className="context-tool-btn has-tooltip"
          onClick={onRewind}
          disabled={!hasMessages}
          data-tooltip={t('rewind.tooltip')}
        >
          <span className="codicon codicon-discard" />
        </button>
      )}
    </div>
  );
});
