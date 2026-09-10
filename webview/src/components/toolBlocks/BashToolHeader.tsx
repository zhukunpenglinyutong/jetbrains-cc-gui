import { useTranslation } from 'react-i18next';

interface BashToolHeaderProps {
  expanded: boolean;
  onToggle: () => void;
  description: string;
  isError: boolean;
  isCompleted: boolean;
}

export default function BashToolHeader({ expanded, onToggle, description, isError, isCompleted }: BashToolHeaderProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`task-header bash-tool-header ${expanded ? 'expanded' : ''}`}
      onClick={onToggle}
    >
      <div className="task-title-section">
        <span className="codicon codicon-terminal bash-tool-icon" />
        <span className="bash-tool-title">{t('tools.runCommand')}</span>
        <span className="bash-tool-description">{description}</span>
      </div>

      <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
    </div>
  );
}
