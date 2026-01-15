import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';

interface FileItem {
  filePath: string;
  cleanFileName: string;
  isDirectory: boolean;
  lineInfo?: string;
  isCompleted: boolean;
  isError: boolean;
}

interface ReadToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
  }>;
}

/** Max visible items before scroll */
const MAX_VISIBLE_ITEMS = 3;
/** Height per item in pixels */
const ITEM_HEIGHT = 28;

/**
 * Extract file path from tool input
 */
const extractFilePath = (input: ToolInput): string | undefined => {
  // Try standard file path fields first
  let filePath =
    (input.file_path as string | undefined) ??
    (input.target_file as string | undefined) ??
    (input.path as string | undefined);

  // If not found, try extracting from Codex command
  if (!filePath && input.command) {
    const workdir = (input.workdir as string | undefined) ?? undefined;
    filePath = extractFilePathFromCommand(input.command as string, workdir);
  }

  return filePath;
};

/**
 * Extract file/directory path from command string (for Codex commands)
 */
const extractFilePathFromCommand = (command: string | undefined, workdir?: string): string | undefined => {
  if (!command || typeof command !== 'string') return undefined;

  let trimmed = command.trim();

  // Extract actual command from shell wrapper
  const shellWrapperMatch = trimmed.match(/^\/bin\/(zsh|bash)\s+(?:-lc|-c)\s+['"](.+)['"]$/);
  if (shellWrapperMatch) {
    trimmed = shellWrapperMatch[2];
  }

  // Remove 'cd dir &&' prefix if present
  const cdPrefixMatch = trimmed.match(/^cd\s+\S+\s+&&\s+(.+)$/);
  if (cdPrefixMatch) {
    trimmed = cdPrefixMatch[1].trim();
  }

  // Match pwd command
  if (/^pwd\s*$/.test(trimmed)) {
    return workdir ? workdir + '/' : undefined;
  }

  // Match ls command
  const lsMatch = trimmed.match(/^ls\s+(?:-[a-zA-Z]+\s+)?(.+)$/);
  if (lsMatch) {
    const path = lsMatch[1].trim().replace(/^["']|["']$/g, '');
    return path.endsWith('/') ? path : path + '/';
  }

  // Match ls without path
  if (/^ls(?:\s+-[a-zA-Z]+)*\s*$/.test(trimmed)) {
    return workdir ? workdir + '/' : undefined;
  }

  // Match tree command
  if (/^tree\b/.test(trimmed)) {
    const treeMatch = trimmed.match(/^tree\s+(.+)$/);
    if (treeMatch) {
      const path = treeMatch[1].trim().replace(/^["']|["']$/g, '');
      return path.endsWith('/') ? path : path + '/';
    }
    return workdir ? workdir + '/' : undefined;
  }

  // Match sed -n command
  const sedMatch = trimmed.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+(.+)$/);
  if (sedMatch) {
    const startLine = sedMatch[1];
    const endLine = sedMatch[2];
    const path = sedMatch[3].trim().replace(/^["']|["']$/g, '');
    return endLine ? `${path}:${startLine}-${endLine}` : `${path}:${startLine}`;
  }

  // Match cat command
  const catMatch = trimmed.match(/^cat\s+(.+)$/);
  if (catMatch) {
    return catMatch[1].trim().replace(/^["']|["']$/g, '');
  }

  // Match head/tail commands
  const headTailMatch = trimmed.match(/^(head|tail)\s+(?:.*\s)?([^\s-][^\s]*)$/);
  if (headTailMatch) {
    return headTailMatch[2].trim().replace(/^["']|["']$/g, '');
  }

  return undefined;
};

/**
 * Parse item to FileItem
 */
const parseFileItem = (item: { input?: ToolInput; result?: ToolResultBlock | null }): FileItem | null => {
  const input = item.input;
  if (!input) return null;

  const filePath = extractFilePath(input);
  if (!filePath) return null;

  const cleanFileName = getFileName(filePath)?.replace(/:\d+(-\d+)?$/, '') || filePath;
  const isDirectory = filePath === '.' || filePath === '..' || filePath.endsWith('/');

  // Extract line info from multiple sources
  let lineInfo = '';

  // Helper to parse number from string or number
  const parseNum = (val: unknown): number | undefined => {
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && /^\d+$/.test(val)) return parseInt(val, 10);
    return undefined;
  };

  const offset = parseNum(input.offset);
  const limit = parseNum(input.limit);

  // 1. Check offset/limit fields (Claude Code standard)
  if (offset !== undefined && limit !== undefined) {
    const startLine = offset + 1;
    const endLine = offset + limit;
    lineInfo = `L${startLine}-${endLine}`;
  }
  // 2. Check line/lines field
  else if (input.line !== undefined || input.lines !== undefined) {
    const line = input.line ?? input.lines;
    const lineNum = parseNum(line);
    if (lineNum !== undefined) {
      lineInfo = `L${lineNum}`;
    } else if (typeof line === 'string') {
      lineInfo = line.startsWith('L') ? line : `L${line}`;
    }
  }
  // 3. Check start_line/end_line fields
  else if (input.start_line !== undefined) {
    const start = parseNum(input.start_line);
    const end = parseNum(input.end_line);
    if (start !== undefined) {
      if (end !== undefined && end !== start) {
        lineInfo = `L${start}-${end}`;
      } else {
        lineInfo = `L${start}`;
      }
    }
  }
  // 4. Extract from file path suffix (e.g., "file.txt:300-370")
  else if (/:\d+(-\d+)?$/.test(filePath)) {
    const match = filePath.match(/:(\d+)(?:-(\d+))?$/);
    if (match) {
      const startLine = match[1];
      const endLine = match[2];
      lineInfo = endLine ? `L${startLine}-${endLine}` : `L${startLine}`;
    }
  }

  // Determine completion status
  const isCompleted = item.result !== undefined && item.result !== null;
  const isError = isCompleted && item.result?.is_error === true;

  return { filePath, cleanFileName, isDirectory, lineInfo, isCompleted, isError };
};

/**
 * Get file icon SVG
 */
const getFileIconSvg = (filePath: string, isDirectory: boolean) => {
  const name = getFileName(filePath);
  if (isDirectory) {
    const cleanName = name.replace(/\/$/, '');
    return getFolderIcon(cleanName);
  }
  const cleanName = name.replace(/:\d+(-\d+)?$/, '');
  const extension = cleanName.indexOf('.') !== -1 ? cleanName.split('.').pop() : '';
  return getFileIcon(extension, cleanName);
};

const ReadToolGroupBlock = ({ items }: ReadToolGroupBlockProps) => {
  // Default to expanded
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);

  // Parse all items to file items
  const fileItems = useMemo(() => {
    return items
      .map(item => parseFileItem(item))
      .filter((item): item is FileItem => item !== null);
  }, [items]);

  // Auto-scroll to bottom when new items are added (streaming)
  useEffect(() => {
    if (listRef.current && fileItems.length > prevItemCountRef.current) {
      // New item added, scroll to bottom
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = fileItems.length;
  }, [fileItems.length]);

  if (fileItems.length === 0) {
    return null;
  }

  // Calculate list height: show up to MAX_VISIBLE_ITEMS, scroll for more
  const needsScroll = fileItems.length > MAX_VISIBLE_ITEMS;
  const listHeight = needsScroll
    ? MAX_VISIBLE_ITEMS * ITEM_HEIGHT
    : fileItems.length * ITEM_HEIGHT;

  const handleFileClick = (filePath: string, isDirectory: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isDirectory) {
      // Remove line number suffix for opening
      const cleanPath = filePath.replace(/:\d+(-\d+)?$/, '');
      openFile(cleanPath);
    }
  };

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section" style={{ overflow: 'hidden' }}>
          <span className="codicon codicon-file-code tool-title-icon" />
          <span className="tool-title-text" style={{ flexShrink: 0 }}>
            {t('permission.tools.ReadBatch')}
          </span>
          <span className="tool-title-summary" style={{
            color: 'var(--text-secondary)',
            marginLeft: '4px',
            flexShrink: 0,
          }}>
            ({fileItems.length})
          </span>
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
            maxHeight: `${listHeight + 12}px`, // +12 for padding
            overflowY: needsScroll ? 'auto' : 'hidden',
            overflowX: 'hidden',
          }}
        >
          {fileItems.map((item, index) => (
            <div
              key={index}
              className={`file-list-item ${!item.isDirectory ? 'clickable-file' : ''}`}
              onClick={(e) => handleFileClick(item.filePath, item.isDirectory, e)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: item.isDirectory ? 'default' : 'pointer',
                transition: 'background-color 0.15s ease',
                minHeight: `${ITEM_HEIGHT}px`,
                flexShrink: 0,
              }}
              title={item.filePath}
            >
              <span
                style={{
                  marginRight: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  width: '16px',
                  height: '16px',
                  flexShrink: 0,
                }}
                dangerouslySetInnerHTML={{ __html: getFileIconSvg(item.filePath, item.isDirectory) }}
              />
              <span
                style={{
                  fontSize: '12px',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {item.cleanFileName}
              </span>
              {item.lineInfo && (
                <span
                  style={{
                    marginLeft: '8px',
                    fontSize: '11px',
                    color: 'var(--text-tertiary, var(--text-secondary))',
                    flexShrink: 0,
                    opacity: 0.8,
                  }}
                >
                  {item.lineInfo}
                </span>
              )}
              {/* Status indicator */}
              <div
                className={`tool-status-indicator ${item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'}`}
                style={{ marginLeft: '8px' }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ReadToolGroupBlock;
