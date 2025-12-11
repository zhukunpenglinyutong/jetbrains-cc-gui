import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput } from '../../types';
import { openFile } from '../../utils/bridge';
import { formatParamValue, getFileName, truncate } from '../../utils/helpers';

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
};

const getToolDisplayName = (t: any, name?: string) => {
  if (!name) {
    return t('tools.toolCall');
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
  };

  const lowerName = name.toLowerCase();
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

const pickFilePath = (input: ToolInput) =>
  (input.file_path as string | undefined) ??
  (input.path as string | undefined) ??
  (input.target_file as string | undefined) ??
  (input.notebook_path as string | undefined);

const omitFields = new Set([
  'file_path',
  'path',
  'target_file',
  'notebook_path',
  'command',
  'search_term',
]);

interface GenericToolBlockProps {
  name?: string;
  input?: ToolInput;
}

const GenericToolBlock = ({ name, input }: GenericToolBlockProps) => {
  const { t } = useTranslation();
  // Tools that should be collapsible (Grep, Glob, Write, and MCP tools)
  const lowerName = (name ?? '').toLowerCase();
  const isMcpTool = lowerName.startsWith('mcp__');
  const isCollapsible = ['grep', 'glob', 'write', 'save-file'].includes(lowerName) || isMcpTool;
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const filePath = pickFilePath(input);
  const displayName = getToolDisplayName(t, name);
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

  // 判断是否为文件路径（非目录）
  const isFilePath = filePath && !filePath.endsWith('/') && filePath !== '.';

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFilePath) {
      openFile(filePath);
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
          <span className={`codicon ${codicon} tool-title-icon`} />

          <span className="tool-title-text">
            {displayName}
          </span>
          {summary && (
              <span
                className={`task-summary-text tool-title-summary ${isFilePath ? 'clickable-file' : ''}`}
                title={isFilePath ? `点击打开 ${filePath}` : summary}
                onClick={isFilePath ? handleFileClick : undefined}
              >
                {summary}
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

