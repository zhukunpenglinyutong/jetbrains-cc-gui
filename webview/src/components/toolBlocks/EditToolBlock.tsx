import { useState, useMemo } from 'react';
import type { ToolInput } from '../../types';
import { openFile } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import GenericToolBlock from './GenericToolBlock';

interface EditToolBlockProps {
  name?: string;
  input?: ToolInput;
}

type DiffLineType = 'unchanged' | 'deleted' | 'added';

interface DiffLine {
  type: DiffLineType;
  content: string;
}

interface DiffResult {
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

// 使用 LCS 算法计算真正的 diff
function computeDiff(oldLines: string[], newLines: string[]): DiffResult {
  if (oldLines.length === 0 && newLines.length === 0) {
    return { lines: [], additions: 0, deletions: 0 };
  }
  if (oldLines.length === 0) {
    return {
      lines: newLines.map(content => ({ type: 'added' as const, content })),
      additions: newLines.length,
      deletions: 0,
    };
  }
  if (newLines.length === 0) {
    return {
      lines: oldLines.map(content => ({ type: 'deleted' as const, content })),
      additions: 0,
      deletions: oldLines.length,
    };
  }

  const m = oldLines.length;
  const n = newLines.length;

  // 计算 LCS 的 DP 表
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  const diffLines: DiffLine[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.unshift({ type: 'unchanged', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.unshift({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      diffLines.unshift({ type: 'deleted', content: oldLines[i - 1] });
      i--;
    }
  }

  const additions = diffLines.filter(l => l.type === 'added').length;
  const deletions = diffLines.filter(l => l.type === 'deleted').length;

  return { lines: diffLines, additions, deletions };
}

const EditToolBlock = ({ name, input }: EditToolBlockProps) => {
  const [expanded, setExpanded] = useState(false);

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

  // 计算真正的差异
  const diff = useMemo(() => computeDiff(oldLines, newLines), [oldLines, newLines]);

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      openFile(filePath);
    }
  };

  return (
    <div className="task-container">
      <div className="task-header" onClick={() => setExpanded((prev) => !prev)}>
        <div className="task-title-section">
          <span className="codicon codicon-edit tool-title-icon" />

          <span className="tool-title-text">
            编辑文件
          </span>
          <span
            className="tool-title-summary clickable-file"
            onClick={handleFileClick}
            title={`点击打开 ${filePath}`}
          >
            {getFileName(filePath) || filePath}
          </span>
          
          {(diff.additions > 0 || diff.deletions > 0) && (
            <span
              style={{
                marginLeft: '12px',
                fontSize: '12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
              }}
            >
              {diff.additions > 0 && <span style={{ color: '#89d185' }}>+{diff.additions}</span>}
              {diff.additions > 0 && diff.deletions > 0 && <span style={{ margin: '0 4px' }} />}
              {diff.deletions > 0 && <span style={{ color: '#ff6b6b' }}>-{diff.deletions}</span>}
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

      {expanded && (
        <div className="task-details" style={{ padding: 0, borderTop: '1px solid var(--border-primary)' }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', 'Consolas', monospace",
              fontSize: '12px',
              lineHeight: 1.5,
              overflowX: 'auto',
              background: '#1e1e1e',
            }}
          >
            {diff.lines.map((line, index) => {
              const isDeleted = line.type === 'deleted';
              const isAdded = line.type === 'added';
              const isUnchanged = line.type === 'unchanged';

              return (
                <div
                  key={index}
                  style={{
                    display: 'flex',
                    background: isDeleted
                      ? 'rgba(80, 20, 20, 0.3)'
                      : isAdded
                        ? 'rgba(20, 80, 20, 0.3)'
                        : 'transparent',
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
                      color: isDeleted ? '#ff6b6b' : isAdded ? '#89d185' : '#666',
                      userSelect: 'none',
                      background: isDeleted
                        ? 'rgba(80, 20, 20, 0.2)'
                        : isAdded
                          ? 'rgba(20, 80, 20, 0.2)'
                          : 'transparent',
                      opacity: isUnchanged ? 0.5 : 0.7,
                    }}
                  >
                    {isDeleted ? '-' : isAdded ? '+' : ' '}
                  </div>
                  <div style={{ whiteSpace: 'pre', paddingLeft: '4px', flex: 1 }}>{line.content}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default EditToolBlock;

