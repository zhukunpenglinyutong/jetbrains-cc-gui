import { useState } from 'react';
import type { ToolInput } from '../../types';
import { getFileName } from '../../utils/helpers';
import GenericToolBlock from './GenericToolBlock';

interface EditToolBlockProps {
  name?: string;
  input?: ToolInput;
}

const EditToolBlock = ({ name, input }: EditToolBlockProps) => {
  const [expanded, setExpanded] = useState(true);

  if (!input) {
    return null;
  }

  const filePath =
    (input.file_path as string | undefined) ??
    (input.path as string | undefined) ??
    (input.target_file as string | undefined);

  const oldString = (input.old_string as string | undefined) ?? '';
  const newString = (input.new_string as string | undefined) ?? '';

  if (!oldString && !newString) {
    return <GenericToolBlock name={name} input={input} />;
  }

  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];

  return (
    <div className="task-container">
      <div className="task-header" onClick={() => setExpanded((prev) => !prev)}>
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
            <span className="codicon codicon-edit" style={{ color: '#64b5f6', fontSize: '12px' }} />
          </div>
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#90caf9' }}>修改</span>
          <span
            style={{
              color: '#ccc',
              marginLeft: '8px',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {getFileName(filePath) || filePath}
          </span>
          {(oldLines.length > 0 || newLines.length > 0) && (
            <span
              style={{
                marginLeft: '12px',
                fontSize: '12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
              }}
            >
              {newLines.length > 0 && <span style={{ color: '#89d185' }}>+{newLines.length}</span>}
              {newLines.length > 0 && oldLines.length > 0 && <span style={{ margin: '0 4px' }} />}
              {oldLines.length > 0 && <span style={{ color: '#ff6b6b' }}>-{oldLines.length}</span>}
            </span>
          )}
        </div>
        <span
          className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`}
          style={{ color: '#858585' }}
        />
      </div>

      {expanded && (
        <div className="task-details" style={{ padding: 0, borderTop: '1px solid #333' }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', 'Consolas', monospace",
              fontSize: '12px',
              lineHeight: 1.5,
              overflowX: 'auto',
              background: '#1e1e1e',
            }}
          >
            {oldLines.map((line, index) => (
              <div
                key={`old-${index}`}
                style={{
                  display: 'flex',
                  background: 'rgba(80, 20, 20, 0.3)',
                  color: '#ccc',
                  minWidth: '100%',
                }}
              >
                <div
                  style={{
                    width: '40px',
                    textAlign: 'right',
                    paddingRight: '10px',
                    color: '#666',
                    userSelect: 'none',
                    borderRight: '1px solid #333',
                    background: '#252526',
                  }}
                />
                <div
                  style={{
                    width: '24px',
                    textAlign: 'center',
                    color: '#ff6b6b',
                    userSelect: 'none',
                    background: 'rgba(80, 20, 20, 0.2)',
                    opacity: 0.7,
                  }}
                >
                  -
                </div>
                <div style={{ whiteSpace: 'pre', paddingLeft: '4px', flex: 1 }}>{line}</div>
              </div>
            ))}

            {newLines.map((line, index) => (
              <div
                key={`new-${index}`}
                style={{
                  display: 'flex',
                  background: 'rgba(20, 80, 20, 0.3)',
                  color: '#ccc',
                  minWidth: '100%',
                }}
              >
                <div
                  style={{
                    width: '40px',
                    textAlign: 'right',
                    paddingRight: '10px',
                    color: '#666',
                    userSelect: 'none',
                    borderRight: '1px solid #333',
                    background: '#252526',
                  }}
                />
                <div
                  style={{
                    width: '24px',
                    textAlign: 'center',
                    color: '#89d185',
                    userSelect: 'none',
                    background: 'rgba(20, 80, 20, 0.2)',
                    opacity: 0.7,
                  }}
                >
                  +
                </div>
                <div style={{ whiteSpace: 'pre', paddingLeft: '4px', flex: 1 }}>{line}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default EditToolBlock;

