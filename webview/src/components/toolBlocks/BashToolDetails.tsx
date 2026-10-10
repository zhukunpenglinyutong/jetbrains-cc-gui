import { useTranslation } from 'react-i18next';

const TASK_DETAILS_STYLE: React.CSSProperties = { padding: 0, border: 'none' };
const TASK_CONTENT_WRAPPER_STYLE: React.CSSProperties = { paddingLeft: '40px', position: 'relative', zIndex: 1 };
const ERROR_ICON_STYLE: React.CSSProperties = { fontSize: '14px', marginTop: '1px' };

interface BashToolDetailsProps {
  command: string;
  description?: string;
  justification?: string;
  output: string;
  isError: boolean;
}

export default function BashToolDetails({ command, description, justification, output, isError }: BashToolDetailsProps) {
  const { t } = useTranslation();
  return (
    <div className="task-details" style={TASK_DETAILS_STYLE}>
      <div className="bash-tool-content">
        <div className="bash-tool-line" />
        <div className="task-content-wrapper" style={TASK_CONTENT_WRAPPER_STYLE}>
          {description && description !== command && <div className="bash-command-summary">{description}</div>}
          {justification && <div className="bash-command-reason">{t('tools.commandApprovalReason')}: {justification}</div>}
          <div className="bash-command-block">{command}</div>

          {output && (
            <div className={`bash-output-block ${isError ? 'error' : 'normal'}`}>
              {isError && (
                <span className="codicon codicon-error" style={ERROR_ICON_STYLE} />
              )}
              <span className="bash-output-text">{output}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
