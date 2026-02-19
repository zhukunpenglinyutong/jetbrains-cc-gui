import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { openFile, showDiff, refreshFile } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import { getFileIcon } from '../../utils/fileIcons';
import GenericToolBlock from './GenericToolBlock';

interface EditToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
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

// Compute actual diff using the LCS algorithm
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

  // Build the LCS dynamic programming table
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

  // Backtrack to generate the diff
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

const EditToolBlock = ({ name, input, result, toolId }: EditToolBlockProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const isDenied = useIsToolDenied(toolId);

  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true);

  const filePath =
    (input?.file_path as string | undefined) ??
    (input?.filePath as string | undefined) ??
    (input?.path as string | undefined) ??
    (input?.target_file as string | undefined) ??
    (input?.targetFile as string | undefined);

  const oldString =
    (input?.old_string as string | undefined) ??
    (input?.oldString as string | undefined) ??
    '';
  const newString =
    (input?.new_string as string | undefined) ??
    (input?.newString as string | undefined) ??
    '';

  const diff = useMemo(() => {
    const oldLines = oldString ? oldString.split('\n') : [];
    const newLines = newString ? newString.split('\n') : [];
    return computeDiff(oldLines, newLines);
  }, [oldString, newString]);

  // Auto-refresh file in IDEA when the tool call completes successfully
  const hasRefreshed = useRef(false);
  useEffect(() => {
    if (filePath && isCompleted && !isError && !hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshFile(filePath);
    }
  }, [filePath, isCompleted, isError]);

  if (!input) {
    return null;
  }

  if (!oldString && !newString) {
    return <GenericToolBlock name={name} input={input} result={result} toolId={toolId} />;
  }

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      openFile(filePath);
    }
  };

  const handleShowDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      showDiff(filePath, oldString, newString, t('tools.editPrefix', { fileName: getFileName(filePath) }));
    }
  };

  const handleRefreshInIdea = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      refreshFile(filePath);
      window.addToast?.(t('tools.refreshFileInIdeaSuccess'), 'success');
    }
  };

  const getFileIconSvg = (path?: string) => {
    if (!path) return '';
    const name = getFileName(path);
    const extension = name.indexOf('.') !== -1 ? name.split('.').pop() : '';
    return getFileIcon(extension, name);
  };

  return (
    <div style={{ margin: '12px 0' }}>
      {/* Top Row: Buttons (Right aligned) */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px', paddingRight: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleShowDiff(e);
            }}
            title={t('tools.showDiffInIdea')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2px 6px',
              fontSize: '11px',
              fontFamily: 'inherit',
              color: 'var(--text-secondary)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-primary)',
              borderRadius: '4px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-tertiary)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <span className="codicon codicon-diff" style={{ marginRight: '4px', fontSize: '12px' }} />
            {t('tools.diffButton')}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRefreshInIdea(e);
            }}
            title={t('tools.refreshFileInIdea')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2px 6px',
              fontSize: '11px',
              fontFamily: 'inherit',
              color: 'var(--text-secondary)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-primary)',
              borderRadius: '4px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-tertiary)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <span className="codicon codicon-refresh" style={{ fontSize: '12px' }} />
          </button>
        </div>
      </div>

      <div className="task-container" style={{ margin: 0 }}>
        <div className="task-header" onClick={() => setExpanded((prev) => !prev)}>
          <div className="task-title-section">
            <span className="codicon codicon-edit tool-title-icon" />

            <span className="tool-title-text">
              {t('tools.editFileTitle')}
            </span>
            <span
              className="tool-title-summary clickable-file"
              onClick={handleFileClick}
              title={t('tools.clickToOpen', { filePath })}
              style={{ display: 'flex', alignItems: 'center' }}
            >
              <span 
                style={{ marginRight: '4px', display: 'flex', alignItems: 'center', width: '16px', height: '16px' }} 
                dangerouslySetInnerHTML={{ __html: getFileIconSvg(filePath) }} 
              />
              {getFileName(filePath) || filePath}
            </span>
            
            {(diff.additions > 0 || diff.deletions > 0) && (
              <span
                style={{
                  marginLeft: '12px',
                  fontSize: '12px',
                  fontFamily: 'var(--idea-editor-font-family, monospace)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {diff.additions > 0 && <span style={{ color: '#89d185' }}>+{diff.additions}</span>}
                {diff.additions > 0 && diff.deletions > 0 && <span style={{ margin: '0 4px' }} />}
                {diff.deletions > 0 && <span style={{ color: '#ff6b6b' }}>-{diff.deletions}</span>}
              </span>
            )}
          </div>

          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
        </div>

        {expanded && (
        <div className="task-details" style={{ padding: 0, borderTop: '1px solid var(--border-primary)' }}>
          <div
            style={{
              // Use monospace font to ensure consistent tab and space widths
              fontFamily: 'var(--idea-editor-font-family, monospace)',
              fontSize: '12px',
              lineHeight: 1.5,
              background: '#1e1e1e',
              // Normalize tab width to prevent indentation shifts across environments
              tabSize: 4 as unknown as number,
              MozTabSize: 4 as unknown as number,
              // Preserve whitespace and line breaks without wrapping to prevent reflow during selection
              whiteSpace: 'pre' as const,
              // Horizontal scroll only to avoid jitter from simultaneous horizontal and vertical changes
              overflowX: 'auto' as const,
              overflowY: 'hidden' as const,
              // Hint the browser to promote this container to a compositing layer for better selection performance
              willChange: 'transform' as const,
              transform: 'translateZ(0)',
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
                      flex: '0 0 40px',
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
                      flex: '0 0 24px',
                    }}
                  >
                    {isDeleted ? '-' : isAdded ? '+' : ' '}
                  </div>
                  <pre
                    style={{
                      // Preserve original whitespace with consistent tab width
                      whiteSpace: 'pre',
                      margin: 0,
                      paddingLeft: '4px',
                      flex: 1,
                      // Re-declare tabSize in case highlight or wrapper layers override it
                      tabSize: 4 as unknown as number,
                      MozTabSize: 4 as unknown as number,
                      // Disable arbitrary line breaks to keep selection and scrolling stable
                      overflowWrap: 'normal' as const,
                    }}
                  >
                    {line.content}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

export default EditToolBlock;
