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

  // Get all input parameters for the expanded view
  const params = Object.entries(input).filter(([key]) => key !== 'file_path' && key !== 'target_file' && key !== 'path');

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
            <span className="codicon codicon-eye" style={{ color: '#64b5f6', fontSize: '12px' }} />
          </div>
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#90caf9' }}>读取</span>
          {lineInfo && (
            <span style={{ color: '#858585', marginLeft: '8px', fontSize: '12px' }}>
              {lineInfo}
            </span>
          )}
          <span
            style={{
              color: '#ccc',
              marginLeft: '8px',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {fileName || filePath}
          </span>
        </div>

        <span
          className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`}
          style={{ color: '#858585' }}
        />
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

