import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile, showDiff, refreshFile } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import { getFileIcon } from '../../utils/fileIcons';

interface EditItem {
  filePath: string;
  fileName: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  isCompleted: boolean;
  isError: boolean;
}

interface EditToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
  }>;
}

/** Max visible items before scroll */
const MAX_VISIBLE_ITEMS = 3;
/** Height per item in pixels */
const ITEM_HEIGHT = 32;

/**
 * Compute diff statistics (additions and deletions count)
 */
function computeDiffStats(oldString: string, newString: string): { additions: number; deletions: number } {
  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];

  if (oldLines.length === 0 && newLines.length === 0) {
    return { additions: 0, deletions: 0 };
  }
  if (oldLines.length === 0) {
    return { additions: newLines.length, deletions: 0 };
  }
  if (newLines.length === 0) {
    return { additions: 0, deletions: oldLines.length };
  }

  // Simple LCS-based diff count
  const m = oldLines.length;
  const n = newLines.length;
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

  let additions = 0;
  let deletions = 0;
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      additions++;
      j--;
    } else {
      deletions++;
      i--;
    }
  }

  return { additions, deletions };
}

/**
 * Parse item to EditItem
 */
function parseEditItem(item: { name?: string; input?: ToolInput; result?: ToolResultBlock | null }): EditItem | null {
  const { input, result } = item;
  if (!input) return null;

  const filePath =
    (input.file_path as string | undefined) ??
    (input.filePath as string | undefined) ??
    (input.path as string | undefined) ??
    (input.target_file as string | undefined) ??
    (input.targetFile as string | undefined);

  if (!filePath) return null;

  const oldString =
    (input.old_string as string | undefined) ??
    (input.oldString as string | undefined) ??
    '';
  const newString =
    (input.new_string as string | undefined) ??
    (input.newString as string | undefined) ??
    '';

  const { additions, deletions } = computeDiffStats(oldString, newString);
  const isCompleted = result !== undefined && result !== null;
  const isError = isCompleted && result?.is_error === true;

  return {
    filePath,
    fileName: getFileName(filePath) || filePath,
    oldString,
    newString,
    additions,
    deletions,
    isCompleted,
    isError,
  };
}

/**
 * Get file icon SVG
 */
function getFileIconSvg(filePath: string): string {
  const name = getFileName(filePath);
  const extension = name.indexOf('.') !== -1 ? name.split('.').pop() : '';
  return getFileIcon(extension, name);
}

const EditToolGroupBlock = ({ items }: EditToolGroupBlockProps) => {
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);
  const refreshedFilesRef = useRef<Set<string>>(new Set());

  // Parse all items
  const editItems = useMemo(() => {
    return items
      .map(item => parseEditItem(item))
      .filter((item): item is EditItem => item !== null);
  }, [items]);

  // Auto-refresh completed files in IDEA
  useEffect(() => {
    editItems.forEach(item => {
      if (item.isCompleted && !item.isError && !refreshedFilesRef.current.has(item.filePath)) {
        refreshedFilesRef.current.add(item.filePath);
        refreshFile(item.filePath);
      }
    });
  }, [editItems]);

  // Auto-scroll to bottom when new items are added
  useEffect(() => {
    if (listRef.current && editItems.length > prevItemCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = editItems.length;
  }, [editItems.length]);

  if (editItems.length === 0) {
    return null;
  }

  // Calculate totals
  const totalAdditions = editItems.reduce((sum, item) => sum + item.additions, 0);
  const totalDeletions = editItems.reduce((sum, item) => sum + item.deletions, 0);

  // Calculate list height
  const needsScroll = editItems.length > MAX_VISIBLE_ITEMS;
  const listHeight = needsScroll
    ? MAX_VISIBLE_ITEMS * ITEM_HEIGHT
    : editItems.length * ITEM_HEIGHT;

  const handleFileClick = (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    openFile(filePath);
  };

  const handleShowDiff = (item: EditItem, e: React.MouseEvent) => {
    e.stopPropagation();
    showDiff(item.filePath, item.oldString, item.newString, t('tools.editPrefix', { fileName: item.fileName }));
  };

  const handleRefresh = (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    refreshFile(filePath);
    window.addToast?.(t('tools.refreshFileInIdeaSuccess'), 'success');
  };

  return (
    <div className="task-container" style={{ margin: '12px 0' }}>
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section" style={{ overflow: 'hidden' }}>
          <span className="codicon codicon-edit tool-title-icon" />
          <span className="tool-title-text" style={{ flexShrink: 0 }}>
            {t('tools.editBatchTitle')}
          </span>
          <span className="tool-title-summary" style={{
            color: 'var(--text-secondary)',
            marginLeft: '4px',
            flexShrink: 0,
          }}>
            ({editItems.length})
          </span>

          {(totalAdditions > 0 || totalDeletions > 0) && (
            <span
              style={{
                marginLeft: '12px',
                fontSize: '12px',
                fontFamily: 'var(--idea-editor-font-family, monospace)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {totalAdditions > 0 && <span style={{ color: '#89d185' }}>+{totalAdditions}</span>}
              {totalAdditions > 0 && totalDeletions > 0 && <span style={{ margin: '0 4px' }} />}
              {totalDeletions > 0 && <span style={{ color: '#ff6b6b' }}>-{totalDeletions}</span>}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="task-details file-list-container"
          style={{
            padding: '6px 8px',
            border: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
            maxHeight: `${listHeight + 12}px`,
            overflowY: needsScroll ? 'auto' : 'hidden',
            overflowX: 'hidden',
          }}
        >
          {editItems.map((item, index) => (
            <div
              key={index}
              className="file-list-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                borderRadius: '4px',
                minHeight: `${ITEM_HEIGHT}px`,
                flexShrink: 0,
                gap: '8px',
              }}
            >
              {/* File icon and name */}
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '16px',
                  height: '16px',
                  flexShrink: 0,
                }}
                dangerouslySetInnerHTML={{ __html: getFileIconSvg(item.filePath) }}
              />
              <span
                className="clickable-file"
                onClick={(e) => handleFileClick(item.filePath, e)}
                style={{
                  fontSize: '12px',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                  cursor: 'pointer',
                }}
                title={item.filePath}
              >
                {item.fileName}
              </span>

              {/* Diff stats */}
              {(item.additions > 0 || item.deletions > 0) && (
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--idea-editor-font-family, monospace)',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {item.additions > 0 && <span style={{ color: '#89d185' }}>+{item.additions}</span>}
                  {item.additions > 0 && item.deletions > 0 && <span style={{ margin: '0 2px' }} />}
                  {item.deletions > 0 && <span style={{ color: '#ff6b6b' }}>-{item.deletions}</span>}
                </span>
              )}

              {/* Action buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                <button
                  onClick={(e) => handleShowDiff(item, e)}
                  title={t('tools.showDiffInIdea')}
                  className="edit-group-action-btn"
                >
                  <span className="codicon codicon-diff" style={{ fontSize: '12px' }} />
                </button>
                <button
                  onClick={(e) => handleRefresh(item.filePath, e)}
                  title={t('tools.refreshFileInIdea')}
                  className="edit-group-action-btn"
                >
                  <span className="codicon codicon-refresh" style={{ fontSize: '12px' }} />
                </button>
              </div>

              {/* Status indicator */}
              <div
                className={`tool-status-indicator ${item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'}`}
                style={{ marginLeft: '4px' }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default EditToolGroupBlock;
