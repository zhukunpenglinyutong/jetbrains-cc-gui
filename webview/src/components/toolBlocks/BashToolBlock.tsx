import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';

interface BashToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** 工具调用的唯一 ID，用于判断该工具是否被用户拒绝了权限 */
  toolId?: string;
}

const BashToolBlock = ({ input, result, toolId }: BashToolBlockProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const command = (input.command as string | undefined) ?? '';
  const description = (input.description as string | undefined) ?? '';

  const isDenied = useIsToolDenied(toolId);

  // Determine tool call status based on result
  // 如果被拒绝，视为已完成（显示错误状态）
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // 如果被拒绝，显示为错误状态
  const isError = isDenied || (isCompleted && result?.is_error === true);

  let output = '';

  if (result) {
    const content = result.content;
    if (typeof content === 'string') {
      output = content;
    } else if (Array.isArray(content)) {
      output = content.map((block) => block.text ?? '').join('\n');
    }
  }

  return (
    <div className="task-container">
      <div
        className={`task-header bash-tool-header ${expanded ? 'expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="task-title-section">
          <span className="codicon codicon-terminal bash-tool-icon" />
          <span className="bash-tool-title">{t('tools.runCommand')}</span>
          <span className="bash-tool-description">{description}</span>
        </div>

        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>

      {expanded && (
        <div className="task-details" style={{ padding: 0, border: 'none' }}>
          <div className="bash-tool-content">
            <div className="bash-tool-line" />
            <div className="task-content-wrapper" style={{ paddingLeft: '40px', position: 'relative', zIndex: 1 }}>
              <div className="bash-command-block">{command}</div>

              {output && (
                <div className={`bash-output-block ${isError ? 'error' : 'normal'}`}>
                  {isError && (
                    <span className="codicon codicon-error" style={{ fontSize: '14px', marginTop: '1px' }} />
                  )}
                  <span>{output}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BashToolBlock;

