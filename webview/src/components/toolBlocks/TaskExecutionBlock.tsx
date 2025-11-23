import { useState } from 'react';
import type { ToolInput } from '../../types';

interface TaskExecutionBlockProps {
  input?: ToolInput;
}

const TaskExecutionBlock = ({ input }: TaskExecutionBlockProps) => {
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const { description, prompt, subagent_type: subagentType, ...rest } = input;

  return (
    <div className="task-container">
      <div className="task-header" onClick={() => setExpanded((prev) => !prev)}>
        <div className="task-title-section">
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#ccc' }}>任务</span>
          {typeof subagentType === 'string' && (
            <span className="task-type-badge">{subagentType}</span>
          )}
          {typeof description === 'string' && (
            <span className="task-summary-text" title={description}>
              {description}
            </span>
          )}
        </div>
        <span
          className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`}
          style={{ color: '#858585' }}
        />
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

