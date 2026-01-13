import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput } from '../../types';
import { openFile } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';

interface ReadToolBlockProps {
  input?: ToolInput;
}

/**
 * Extract file/directory path from command string (for Codex commands)
 */
const extractFilePathFromCommand = (command: string | undefined, workdir?: string): string | undefined => {
  if (!command || typeof command !== 'string') return undefined;

  let trimmed = command.trim();

  // Extract actual command from shell wrapper (/bin/zsh -lc '...' or /bin/bash -c '...')
  const shellWrapperMatch = trimmed.match(/^\/bin\/(zsh|bash)\s+(?:-lc|-c)\s+['"](.+)['"]$/);
  if (shellWrapperMatch) {
    trimmed = shellWrapperMatch[2];
  }

  // Remove 'cd dir &&' prefix if present
  const cdPrefixMatch = trimmed.match(/^cd\s+\S+\s+&&\s+(.+)$/);
  if (cdPrefixMatch) {
    trimmed = cdPrefixMatch[1].trim();
  }

  // Match pwd command - returns current directory from workdir
  if (/^pwd\s*$/.test(trimmed)) {
    return workdir ? workdir + '/' : undefined;
  }

  // Match ls command (with or without flags)
  const lsMatch = trimmed.match(/^ls\s+(?:-[a-zA-Z]+\s+)?(.+)$/);
  if (lsMatch) {
    const path = lsMatch[1].trim().replace(/^["']|["']$/g, '');
    return path.endsWith('/') ? path : path + '/';
  }

  // Match ls without path (current directory)
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

  // Match sed -n command (e.g., sed -n '700,780p' file.txt)
  const sedMatch = trimmed.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+(.+)$/);
  if (sedMatch) {
    const startLine = sedMatch[1];
    const endLine = sedMatch[2];
    const path = sedMatch[3].trim().replace(/^["']|["']$/g, '');
    if (endLine) {
      return `${path}:${startLine}-${endLine}`;
    } else {
      return `${path}:${startLine}`;
    }
  }

  // Match cat command
  const catMatch = trimmed.match(/^cat\s+(.+)$/);
  if (catMatch) {
    const path = catMatch[1].trim();
    return path.replace(/^["']|["']$/g, '');
  }

  // Match head/tail commands
  const headTailMatch = trimmed.match(/^(head|tail)\s+(?:.*\s)?([^\s-][^\s]*)$/);
  if (headTailMatch) {
    const path = headTailMatch[2].trim();
    return path.replace(/^["']|["']$/g, '');
  }

  return undefined;
};

const ReadToolBlock = ({ input }: ReadToolBlockProps) => {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  if (!input) {
    return null;
  }

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

  // Remove line number suffix for display
  const cleanFileName = getFileName(filePath)?.replace(/:\d+(-\d+)?$/, '') || '';
  const fileName = getFileName(filePath);

  // Extract line info from either standard fields or from file path suffix
  let lineInfo = '';

  // First try standard offset/limit fields
  if (typeof input.offset === 'number' && typeof input.limit === 'number') {
    const startLine = Number(input.offset) + 1;
    const endLine = Number(input.offset) + Number(input.limit);
    lineInfo = t('tools.lineRange', { start: startLine, end: endLine });
  }
  // If not found, try extracting from file path suffix (e.g., "file.txt:300-370")
  else if (filePath && /:\d+(-\d+)?$/.test(filePath)) {
    const match = filePath.match(/:(\d+)(?:-(\d+))?$/);
    if (match) {
      const startLine = match[1];
      const endLine = match[2];
      if (endLine) {
        lineInfo = `第 ${startLine}-${endLine} 行`;
      } else {
        lineInfo = `第 ${startLine} 行`;
      }
    }
  }

  // Check if it's a directory (ends with / or is . or ..)
  const isDirectory = filePath === '.' || filePath === '..' || filePath?.endsWith('/');
  const iconClass = isDirectory ? 'codicon-folder' : 'codicon-file-code';
  const actionText = isDirectory ? t('permission.tools.readDirectory') : t('permission.tools.Read');

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止冒泡，避免触发展开/折叠
    if (filePath && !isDirectory) {
      openFile(filePath);
    }
  };

  const getFileIconSvg = (path?: string) => {
    if (!path) return '';
    const name = getFileName(path);

    if (isDirectory) {
      // Use folder icon for directories
      return getFolderIcon(cleanFileName);
    } else {
      // Remove line number suffix if present
      const cleanName = name.replace(/:\d+(-\d+)?$/, '');
      const extension = cleanName.indexOf('.') !== -1 ? cleanName.split('.').pop() : '';
      return getFileIcon(extension, cleanName);
    }
  };

  // Get all input parameters for the expanded view, excluding Codex-specific fields
  const params = Object.entries(input).filter(([key]) =>
    key !== 'file_path' &&
    key !== 'target_file' &&
    key !== 'path' &&
    key !== 'command' &&    // Omit Codex command field
    key !== 'workdir' &&    // Omit Codex workdir field
    key !== 'description'   // Omit Codex description field
  );

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
          <span
            className={`tool-title-summary ${!isDirectory ? 'clickable-file' : ''}`}
            onClick={!isDirectory ? handleFileClick : undefined}
            title={!isDirectory ? t('tools.clickToOpen', { filePath }) : undefined}
            style={{ display: 'flex', alignItems: 'center' }}
          >
            <span
              style={{ marginRight: '4px', display: 'flex', alignItems: 'center', width: '16px', height: '16px' }}
              dangerouslySetInnerHTML={{ __html: getFileIconSvg(filePath) }}
            />
            {cleanFileName || fileName || filePath}
          </span>

          {lineInfo && (
            <span className="tool-title-summary" style={{ marginLeft: '8px', fontSize: '12px' }}>
              {lineInfo}
            </span>
          )}
        </div>

        <div className="tool-status-indicator completed" />
      </div>

      {expanded && params.length > 0 && (
        <div className="task-details" style={{ padding: '12px', border: 'none' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              fontFamily: 'var(--idea-editor-font-family, monospace)',
              fontSize: '12px',
            }}
          >
            {params.map(([key, value]) => (
              <div
                key={key}
                style={{
                  color: '#858585',
                  display: 'flex',
                  alignItems: 'baseline',
                  overflow: 'hidden'
                }}
              >
                <span style={{ color: '#90caf9', fontWeight: 600, flexShrink: 0 }}>{key}：</span>
                <span
                  style={{
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                    flex: 1
                  }}
                >
                  {String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadToolBlock;

