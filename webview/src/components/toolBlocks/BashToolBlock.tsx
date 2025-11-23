import { useState } from 'react';
import type { ToolInput, ToolResultBlock } from '../../types';

interface BashToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
}

const BashToolBlock = ({ input, result }: BashToolBlockProps) => {
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const command = (input.command as string | undefined) ?? '';
  const description = (input.description as string | undefined) ?? '';

  let status: 'pending' | 'completed' | 'error' = 'pending';
  let isError = false;
  let output = '';

  if (result) {
    status = 'completed';
    if (result.is_error) {
      status = 'error';
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
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{ borderBottom: expanded ? '1px solid #333' : undefined }}
      >
        <div className="task-title-section">
          <div
            className="task-icon-wrapper"
            style={{
              width: '20px',
              height: '20px',
              background: 'rgba(100, 181, 246, 0.15)',
              marginRight: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px',
            }}
          >
            <span
              className="codicon codicon-terminal"
              style={{ color: '#64b5f6', fontSize: '12px' }}
            />
          </div>
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#90caf9' }}>命令行</span>
          {description && (
            <span style={{ color: '#858585', marginLeft: '8px', fontStyle: 'italic', fontSize: '12px' }}>
              {description}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {status !== 'pending' && (
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: isError ? '#ff6b6b' : '#89d185',
              }}
            />
          )}
          <span
            className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`}
            style={{ color: '#858585' }}
          />
        </div>
      </div>

      {expanded && (
        <div className="task-details" style={{ padding: 0, border: 'none' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              background: '#1e1e1e',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '21px',
                top: 0,
                bottom: 0,
                width: '1px',
                backgroundColor: '#333',
                zIndex: 0,
              }}
            />
            <div className="task-content-wrapper" style={{ paddingLeft: '40px', position: 'relative', zIndex: 1 }}>
              <div
                style={{
                  background: '#252526',
                  border: '1px solid #333',
                  borderRadius: '6px',
                  padding: '10px 12px',
                  fontFamily: "'JetBrains Mono', 'Consolas', monospace",
                  fontSize: '13px',
                  color: '#cccccc',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {command}
              </div>

              {output && (
                <div
                  style={{
                    marginTop: '8px',
                    fontFamily: "'JetBrains Mono', 'Consolas', monospace",
                    fontSize: '12px',
                    color: isError ? '#ff6b6b' : '#858585',
                    whiteSpace: 'pre-wrap',
                    display: 'flex',
                    gap: '6px',
                  }}
                >
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

