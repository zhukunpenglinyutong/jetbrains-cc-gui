import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';

interface BashToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
}

const BashToolBlock = ({ input, result }: BashToolBlockProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const command = (input.command as string | undefined) ?? '';
  const description = (input.description as string | undefined) ?? '';

  let isError = false;
  let output = '';

  if (result) {
    if (result.is_error) {
      isError = true;
    }

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

        <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'var(--color-success)',
            marginRight: '4px'
        }} />
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

