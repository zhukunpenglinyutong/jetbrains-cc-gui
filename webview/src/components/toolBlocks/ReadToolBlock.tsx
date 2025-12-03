import { useState } from 'react';
import type { ToolInput } from '../../types';
import { getFileName } from '../../utils/helpers';

interface ReadToolBlockProps {
  input?: ToolInput;
}

const ReadToolBlock = ({ input }: ReadToolBlockProps) => {
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const filePath =
    (input.file_path as string | undefined) ??
    (input.target_file as string | undefined) ??
    (input.path as string | undefined);

  const fileName = getFileName(filePath);

  let lineInfo = '';
  if (typeof input.offset === 'number' && typeof input.limit === 'number') {
    const startLine = Number(input.offset) + 1;
    const endLine = Number(input.offset) + Number(input.limit);
    lineInfo = `第 ${startLine}-${endLine} 行`;
  }

  const isDirectory = filePath === '.' || filePath?.endsWith('/');
  const iconClass = isDirectory ? 'codicon-folder' : 'codicon-file-code';
  const actionText = isDirectory ? '读取目录' : '读取文件';

  // Get all input parameters for the expanded view
  const params = Object.entries(input).filter(([key]) => key !== 'file_path' && key !== 'target_file' && key !== 'path');

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section">
          <span className={`codicon ${iconClass} tool-title-icon`} />

          <span className="tool-title-text">
            {actionText}
          </span>
          <span className="tool-title-summary">{fileName || filePath}</span>

          {lineInfo && (
            <span className="tool-title-summary" style={{ marginLeft: '8px', fontSize: '12px' }}>
              {lineInfo}
            </span>
          )}
        </div>

        <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'var(--color-success)',
            marginRight: '4px'
        }} />
      </div>

      {expanded && params.length > 0 && (
        <div className="task-details" style={{ padding: '12px', border: 'none' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              fontFamily: "'JetBrains Mono', 'Consolas', monospace",
              fontSize: '12px',
            }}
          >
            <div style={{ color: '#858585' }}>
              <span style={{ color: '#90caf9', fontWeight: 600 }}>文件路径：</span>
              <span style={{ color: '#a5d6a7' }}>{filePath}</span>
            </div>
            {params.map(([key, value]) => (
              <div key={key} style={{ color: '#858585' }}>
                <span style={{ color: '#90caf9', fontWeight: 600 }}>{key}：</span>
                <span>{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadToolBlock;

