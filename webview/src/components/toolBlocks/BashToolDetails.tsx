const TASK_DETAILS_STYLE: React.CSSProperties = { padding: 0, border: 'none' };
const TASK_CONTENT_WRAPPER_STYLE: React.CSSProperties = { paddingLeft: '40px', position: 'relative', zIndex: 1 };
const ERROR_ICON_STYLE: React.CSSProperties = { fontSize: '14px', marginTop: '1px' };

interface BashToolDetailsProps {
  command: string;
  output: string;
  isError: boolean;
}

export default function BashToolDetails({ command, output, isError }: BashToolDetailsProps) {
  return (
    <div className="task-details" style={TASK_DETAILS_STYLE}>
      <div className="bash-tool-content">
        <div className="bash-tool-line" />
        <div className="task-content-wrapper" style={TASK_CONTENT_WRAPPER_STYLE}>
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
