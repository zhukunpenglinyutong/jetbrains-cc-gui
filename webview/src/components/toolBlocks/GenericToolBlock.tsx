import { useState } from 'react';
import type { ToolInput } from '../../types';
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

const getToolDisplayName = (name?: string) => {
  if (!name) {
    return '工具调用';
  }

  // 中文映射表
  const chineseNameMap: Record<string, string> = {
    'augmentcontextengine': '上下文引擎',
    'task': '任务',
    'read': '读取文件',
    'read_file': '读取文件',
    'edit': '编辑文件',
    'edit_file': '编辑文件',
    'write': '写入文件',
    'write_to_file': '写入文件',
    'replace_string': '替换字符串',
    'bash': '运行命令',
    'run_terminal_cmd': '运行命令',
    'execute_command': '执行命令',
    'executecommand': '执行命令',
    'grep': '搜索',
    'glob': '文件匹配',
    'webfetch': '网页获取',
    'websearch': '网页搜索',
    'delete': '删除',
    'explore': '探索',
    'createdirectory': '创建目录',
    'movefile': '移动文件',
    'copyfile': '复制文件',
    'list': '列出文件',
    'search': '搜索',
    'find': '查找文件',
    'todowrite': '任务列表',
  };

  const lowerName = name.toLowerCase();
  if (chineseNameMap[lowerName]) {
    return chineseNameMap[lowerName];
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
  // Tools that should be collapsible (Grep, Glob, and Write)
  const isCollapsible = ['grep', 'glob', 'write', 'save-file'].includes((name ?? '').toLowerCase());
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const filePath = pickFilePath(input);
  const displayName = getToolDisplayName(name);
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

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={isCollapsible ? () => setExpanded((prev) => !prev) : undefined}
        style={{
          cursor: isCollapsible ? 'pointer' : 'default',
          borderBottom: expanded && isCollapsible ? '1px solid #333' : undefined,
        }}
      >
        <div className="task-title-section">
          <span className={`codicon ${codicon}`} style={{ color: '#cccccc', fontSize: '16px', marginRight: '6px' }} />

          <span style={{ fontWeight: 500, fontSize: '13px', color: '#ffffff' }}>
            {displayName}
          </span>
          {summary && (
              <span className="task-summary-text" title={summary} style={{ marginLeft: '12px', color: '#858585' }}>
                {summary}
              </span>
            )}
        </div>
        
        <div style={{ 
            width: '8px', 
            height: '8px', 
            borderRadius: '50%', 
            backgroundColor: '#4caf50',
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

