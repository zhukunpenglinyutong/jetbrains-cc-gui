import { useTranslation } from 'react-i18next';

const MONO_FONT_STYLE: React.CSSProperties = {
  fontFamily: "var(--cc-gui-code-font-family, var(--idea-editor-font-family, 'JetBrains Mono', 'Consolas', monospace))",
};
const NORMAL_WEIGHT_STYLE: React.CSSProperties = { fontWeight: 'normal' };

interface TaskExecutionHeaderProps {
  name?: string;
  expanded: boolean;
  onToggle: () => void;
  isSpawnAgent: boolean;
  identityLabel?: string;
  modelSummary: string;
  shortAgentId?: string;
  descriptionText?: string;
  isError: boolean;
  isCompleted: boolean;
}

export default function TaskExecutionHeader({
  name,
  expanded,
  onToggle,
  isSpawnAgent,
  identityLabel,
  modelSummary,
  shortAgentId,
  descriptionText,
  isError,
  isCompleted,
}: TaskExecutionHeaderProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
      onClick={onToggle}
    >
      <div className="task-title-section">
        <span className="codicon codicon-tools tool-title-icon" />

        <span className="tool-title-text">
          {name ?? t('tools.task')}
        </span>
        {identityLabel && (
          <span className="tool-title-summary">{identityLabel}</span>
        )}
        {modelSummary && (
          <span className="tool-title-summary">· {modelSummary}</span>
        )}
        {shortAgentId && (
          <span className="tool-title-summary" style={MONO_FONT_STYLE}>
            · {shortAgentId}
          </span>
        )}

        {!isSpawnAgent && descriptionText !== undefined && (
          <span className="task-summary-text tool-title-summary" title={descriptionText} style={NORMAL_WEIGHT_STYLE}>
            {descriptionText}
          </span>
        )}
      </div>

      <div className="task-header-right">
        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>
    </div>
  );
}
