import { useState } from 'react';
import type { ToolInput, ToolResultBlock } from '../../types';

interface TaskExecutionBlockProps {
  input?: ToolInput;
  result?: ToolResultBlock | null;
}

const TaskExecutionBlock = ({ input, result }: TaskExecutionBlockProps) => {
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const { description, prompt, subagent_type: subagentType, ...rest } = input;

  // Determine status based on result
  const isCompleted = result !== undefined && result !== null;
  const isError = isCompleted && result?.is_error === true;

  return (
    <div className="task-container">
      <div className="task-header" onClick={() => setExpanded((prev) => !prev)}>
        <div className="task-title-section">
          <span className="codicon codicon-tools tool-title-icon" />

          <span className="tool-title-text">
            任务
          </span>
          {typeof subagentType === 'string' && subagentType && (
            <span className="tool-title-summary">{subagentType}</span>
          )}

          {typeof description === 'string' && (
            <span className="task-summary-text tool-title-summary" title={description} style={{ fontWeight: 'normal' }}>
              {description}
            </span>
          )}
        </div>

        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>

      {expanded && (
        <div className="task-details">
          <div className="task-content-wrapper">
            {typeof prompt === 'string' && (
              <div className="task-field">
                <div className="task-field-label">
                  <span className="codicon codicon-comment" />
                  提示词 (Prompt)
                </div>
                <div className="task-field-content">{prompt}</div>
              </div>
            )}

            {Object.entries(rest).map(([key, value]) => (
              <div key={key} className="task-field">
                <div className="task-field-label">{key}</div>
                <div className="task-field-content">
                  {typeof value === 'object' && value !== null
                    ? JSON.stringify(value, null, 2)
                    : String(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskExecutionBlock;

