import { useTranslation } from 'react-i18next';

interface AgentGroupHeaderProps {
  toolName: string;
  agentType: string;
  summary: string;
  expanded: boolean;
  isError: boolean;
  isCompleted: boolean;
  onToggle: () => void;
}

function AgentGroupHeader({
  toolName,
  agentType,
  summary,
  expanded,
  isError,
  isCompleted,
  onToggle,
}: AgentGroupHeaderProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
      onClick={onToggle}
      role="button"
      aria-expanded={expanded}
      aria-label={t('tools.agentGroupToggle', 'Toggle agent group details')}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <div className="task-title-section">
        <span className="codicon codicon-type-hierarchy tool-title-icon" />
        <span className="tool-title-text">
          {toolName === 'spawn_agent' ? 'spawn_agent' : t('tools.agent', 'Agent')}
        </span>
        {agentType && (
          <span className="tool-title-summary">{agentType}</span>
        )}
        {summary && (
          <span className="task-summary-text tool-title-summary" title={summary}>
            {summary}
          </span>
        )}
      </div>

      <div className="task-header-right">
        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
        <span className={`codicon agent-group-chevron ${expanded ? 'codicon-chevron-up' : 'codicon-chevron-down'}`} />
      </div>
    </div>
  );
}

export default AgentGroupHeader;
