import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile } from '../../utils/bridge';
import { formatParamValue, getFileName, truncate } from '../../utils/helpers';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';

const CODICON_MAP: Record<string, string> = {
  read: 'codicon-eye',
  edit: 'codicon-edit',
  write: 'codicon-pencil',
  bash: 'codicon-terminal',
  grep: 'codicon-search',
  glob: 'codicon-folder',
  task: 'codicon-tools',
  webfetch: 'codicon-globe',
  websearch: 'codicon-search',
  delete: 'codicon-trash',
  augmentcontextengine: 'codicon-symbol-class', // Added based on Picture 2
  update_plan: 'codicon-checklist', // Update plan tool
  shell_command: 'codicon-terminal', // Shell command tool
};

/**
 * Check if a shell command is a file/directory viewing operation
 */
const isFileViewingCommand = (command?: string): boolean => {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  // File viewing: pwd, ls, cat, head, tail, sed -n, tree
  return /^(pwd|ls|cat|head|tail|tree|file|stat)\b/.test(trimmed) ||
         /^sed\s+-n\s+/.test(trimmed);
};

const getToolDisplayName = (t: any, name?: string, input?: ToolInput) => {
  if (!name) {
    return t('tools.toolCall');
  }

  const lowerName = name.toLowerCase();

  // For shell_command, check the actual command to determine display name
  if (lowerName === 'shell_command' && input?.command) {
    if (isFileViewingCommand(input.command as string)) {
      return t('tools.readFile');
    }
  }

  // Translation key mapping
  const toolKeyMap: Record<string, string> = {
    'augmentcontextengine': 'tools.contextEngine',
    'task': 'tools.task',
    'read': 'tools.readFile',
    'read_file': 'tools.readFile',
    'edit': 'tools.editFile',
    'edit_file': 'tools.editFile',
    'write': 'tools.writeFile',
    'write_to_file': 'tools.writeFile',
    'replace_string': 'tools.replaceString',
    'bash': 'tools.runCommand',
    'run_terminal_cmd': 'tools.runCommand',
    'execute_command': 'tools.executeCommand',
    'executecommand': 'tools.executeCommand',
    'shell_command': 'tools.runCommand',
    'grep': 'tools.search',
    'glob': 'tools.fileMatch',
    'webfetch': 'tools.webFetch',
    'websearch': 'tools.webSearch',
    'delete': 'tools.delete',
    'explore': 'tools.explore',
    'createdirectory': 'tools.createDirectory',
    'movefile': 'tools.moveFile',
    'copyfile': 'tools.copyFile',
    'list': 'tools.listFiles',
    'search': 'tools.search',
    'find': 'tools.findFile',
    'todowrite': 'tools.todoList',
    'update_plan': 'tools.updatePlan',
  };

  if (toolKeyMap[lowerName]) {
    return t(toolKeyMap[lowerName]);
  }

  // If it's snake_case, replace underscores with spaces and capitalize
  if (name.includes('_')) {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  // If it's CamelCase (starts with uppercase), split by capital letters
  // e.g. WebSearch -> Web Search
  if (/^[A-Z]/.test(name)) {
    return name.replace(/([A-Z])/g, ' $1').trim();
  }

  return name;
};

/**
 * Extract file/directory path from command string (for Codex commands)
 * Returns the path with optional metadata suffix (e.g., ":700-780" for line ranges, "/" for directories)
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
  // Examples: ls, ls -a, ls -la, ls /path, ls -a /path
  const lsMatch = trimmed.match(/^ls\s+(?:-[a-zA-Z]+\s+)?(.+)$/);
  if (lsMatch) {
    const path = lsMatch[1].trim().replace(/^["']|["']$/g, '');
    // Add trailing slash to indicate directory
    return path.endsWith('/') ? path : path + '/';
  }

  // Match ls without path (current directory)
  if (/^ls(?:\s+-[a-zA-Z]+)*\s*$/.test(trimmed)) {
    return workdir ? workdir + '/' : undefined;
  }

  // Match tree command (directory listing)
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

    // Return file path with line range info
    if (endLine) {
      return `${path}:${startLine}-${endLine}`;
    } else {
      return `${path}:${startLine}`;
    }
  }

  // Match cat command (simple case without flags)
  const catMatch = trimmed.match(/^cat\s+(.+)$/);
  if (catMatch) {
    const path = catMatch[1].trim();
    // Remove quotes if present
    return path.replace(/^["']|["']$/g, '');
  }

  // Match head/tail commands (may have flags like -n 10)
  const headTailMatch = trimmed.match(/^(head|tail)\s+(?:.*\s)?([^\s-][^\s]*)$/);
  if (headTailMatch) {
    const path = headTailMatch[2].trim();
    // Remove quotes if present
    return path.replace(/^["']|["']$/g, '');
  }

  return undefined;
};

const pickFilePath = (input: ToolInput, name?: string) => {
  // First try standard file path fields
  const standardPath = (input.file_path as string | undefined) ??
    (input.path as string | undefined) ??
    (input.target_file as string | undefined) ??
    (input.notebook_path as string | undefined);

  if (standardPath) return standardPath;

  // For Codex read or shell_command commands, extract from command string
  const lowerName = (name ?? '').toLowerCase();
  if ((lowerName === 'read' || lowerName === 'shell_command') && input.command) {
    const workdir = (input.workdir as string | undefined) ?? undefined;
    return extractFilePathFromCommand(input.command as string, workdir);
  }

  return undefined;
};

const omitFields = new Set([
  'file_path',
  'path',
  'target_file',
  'notebook_path',
  'command',
  'search_term',
  'description',  // Omit Codex description field
  'workdir',      // Omit Codex workdir field
]);

interface GenericToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
}

const GenericToolBlock = ({ name, input, result }: GenericToolBlockProps) => {
  const { t } = useTranslation();
  // Tools that should be collapsible (Grep, Glob, Write, Update Plan, Shell Command and MCP tools)
  const lowerName = (name ?? '').toLowerCase();
  const isMcpTool = lowerName.startsWith('mcp__');
  const isCollapsible = ['grep', 'glob', 'write', 'save-file', 'askuserquestion', 'update_plan', 'shell_command', 'exitplanmode', 'websearch'].includes(lowerName) || isMcpTool;
  const [expanded, setExpanded] = useState(false);

  const filePath = input ? pickFilePath(input, name) : undefined;

  // Determine tool call status based on result
  const isCompleted = result !== undefined && result !== null;
  // AskUserQuestion tool should never show as error - it's a user interaction tool
  // The is_error field may be set by SDK but it doesn't indicate a real error
  const isAskUserQuestion = lowerName === 'askuserquestion';
  const isError = isCompleted && result?.is_error === true && !isAskUserQuestion;

  if (!input) {
    return null;
  }

  const displayName = getToolDisplayName(t, name, input);
  const codicon = CODICON_MAP[(name ?? '').toLowerCase()] ?? 'codicon-tools';

  let summary: string | null = null;
  if (filePath) {
    summary = getFileName(filePath);
  } else if (typeof input.command === 'string') {
    summary = truncate(input.command);
  } else if (typeof input.search_term === 'string') {
    summary = truncate(input.search_term);
  } else if (typeof input.pattern === 'string') {
    summary = truncate(input.pattern);
  }

  const otherParams = Object.entries(input).filter(
    ([key]) => !omitFields.has(key) && key !== 'pattern',
  );

  const shouldShowDetails = otherParams.length > 0 && (!isCollapsible || expanded);

  // 检查是否为特殊文件（没有扩展名但确实是文件）
  const isSpecialFile = (fileName: string): boolean => {
    const specialFiles = [
      'makefile', 'dockerfile', 'jenkinsfile', 'vagrantfile',
      'gemfile', 'rakefile', 'procfile', 'guardfile',
      'license', 'licence', 'readme', 'changelog',
      'gradlew', 'cname', 'authors', 'contributors'
    ];
    return specialFiles.includes(fileName.toLowerCase());
  };

  // 判断是否为目录：以 / 结尾、是 . 或 ..、或者文件名不包含扩展名（且不是特殊文件）
  const fileName = filePath ? getFileName(filePath) : '';
  // Remove line number suffix when checking if it's a directory
  const cleanFileName = fileName.replace(/:\d+(-\d+)?$/, '');
  const isDirectoryPath = filePath && (
    filePath.endsWith('/') ||
    filePath === '.' ||
    filePath === '..' ||
    (!cleanFileName.includes('.') && !isSpecialFile(cleanFileName))
  );
  // 判断是否为文件路径（非目录）
  const isFilePath = filePath && !isDirectoryPath;

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFilePath) {
      openFile(filePath);
    }
  };

  const getFileIconSvg = (path?: string) => {
    if (!path) return '';
    const name = getFileName(path);

    if (isDirectoryPath) {
      // 对于目录，使用 getFolderIcon 获取彩色文件夹图标
      return getFolderIcon(name);
    } else {
      // Remove line number suffix if present (e.g., "App.tsx:700-780" -> "App.tsx")
      const cleanName = name.replace(/:\d+(-\d+)?$/, '');
      const extension = cleanName.indexOf('.') !== -1 ? cleanName.split('.').pop() : '';
      return getFileIcon(extension, cleanName);
    }
  };

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={isCollapsible ? () => setExpanded((prev) => !prev) : undefined}
        style={{
          cursor: isCollapsible ? 'pointer' : 'default',
          borderBottom: expanded && isCollapsible ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section">
          {isCollapsible && (
            <span
              className="codicon codicon-chevron-right"
              style={{
                marginRight: '4px',
                transform: expanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.2s',
                fontSize: '12px',
                color: 'var(--vscode-descriptionForeground)',
              }}
            />
          )}
          <span className={`codicon ${codicon} tool-title-icon`} />

          <span className="tool-title-text">
            {displayName}
          </span>
          {summary && (
              <span
                className={`task-summary-text tool-title-summary ${isFilePath ? 'clickable-file' : ''}`}
                title={isFilePath ? `点击打开 ${filePath}` : summary}
                onClick={isFilePath ? handleFileClick : undefined}
                style={(isFilePath || isDirectoryPath) ? {
                  display: 'inline-flex',
                  alignItems: 'center',
                  maxWidth: 'fit-content'
                } : undefined}
              >
                {(isFilePath || isDirectoryPath) && (
                   <span
                      style={{ marginRight: '4px', display: 'flex', alignItems: 'center', width: '16px', height: '16px' }}
                      dangerouslySetInnerHTML={{ __html: getFileIconSvg(filePath) }}
                   />
                )}
                {summary}
              </span>
            )}
        </div>

        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>
      {shouldShowDetails && (
        <div className="task-details">
          <div className="task-content-wrapper">
            {otherParams.map(([key, value]) => (
              <div key={key} className="task-field">
                <div className="task-field-label">{key}</div>
                <div className="task-field-content">{formatParamValue(value)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default GenericToolBlock;

